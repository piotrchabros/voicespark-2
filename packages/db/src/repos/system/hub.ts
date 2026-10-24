import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb, type DbOrTx } from '../../client';
import { hubFile, hubLlmCall, hubSyncItem, hubThread } from '../../schema';

/** Thread lease length (data-model: hub_thread state machine). */
export const HUB_THREAD_LEASE_SECONDS = 600;

export type HubThreadOutcome = 'done' | 'skipped';

type Rows<T> = T[] | { rows: T[] };

function rowsOf<T>(res: unknown): T[] {
  const r = res as Rows<T>;
  return Array.isArray(r) ? r : r.rows;
}

/**
 * Claims a due thread in one statement and returns the claimed `version`, or null when the
 * thread is not due, is leased, or is gone.
 */
export async function claimThread(threadId: string, db: DbOrTx = getDb()): Promise<number | null> {
  const res = await db.execute(sql`
    UPDATE hub_thread
    SET locked_until = now() + make_interval(secs => ${HUB_THREAD_LEASE_SECONDS})
    WHERE id = ${threadId}
      AND status = 'pending'
      AND version > processed_version
      AND next_attempt_at <= now()
      AND (locked_until IS NULL OR locked_until < now())
    RETURNING version
  `);
  const row = rowsOf<{ version: string | number }>(res)[0];
  return row ? Number(row.version) : null;
}

/**
 * Completes a claimed run only while the lease is still held. The thread becomes `outcome` only
 * when `version` is still the claimed one; a version bumped during the run leaves it `pending`
 * with `next_attempt_at = now()` so the sweep re-claims it. Returns false when the lease was lost.
 */
export async function completeThread(
  threadId: string,
  claimedVersion: number,
  outcome: HubThreadOutcome,
  skipReason: (typeof hubThread.$inferSelect)['skipReason'] = null,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE hub_thread
    SET status = CASE WHEN version = ${claimedVersion} THEN ${outcome}::hub_thread_status ELSE 'pending'::hub_thread_status END,
        skip_reason = CASE WHEN version = ${claimedVersion} THEN ${outcome === 'skipped' ? skipReason : null}::hub_skip_reason ELSE NULL END,
        processed_version = ${claimedVersion},
        processed_at = now(),
        attempts = 0,
        last_error_code = NULL,
        next_attempt_at = CASE WHEN version = ${claimedVersion} THEN NULL ELSE now() END,
        locked_until = NULL
    WHERE id = ${threadId}
      AND locked_until IS NOT NULL
      AND locked_until >= now()
    RETURNING id
  `);
  return rowsOf<{ id: string }>(res).length > 0;
}

export interface DueThread {
  id: string;
  userId: string;
  version: number;
}

/** Threads the sweep should enqueue: same predicate as {@link claimThread}. */
export async function dueThreads(limit: number, db: DbOrTx = getDb()): Promise<DueThread[]> {
  return db
    .select({ id: hubThread.id, userId: hubThread.userId, version: hubThread.version })
    .from(hubThread)
    .where(
      and(
        eq(hubThread.status, 'pending'),
        sql`${hubThread.version} > ${hubThread.processedVersion}`,
        sql`${hubThread.nextAttemptAt} <= now()`,
        sql`(${hubThread.lockedUntil} IS NULL OR ${hubThread.lockedUntil} < now())`,
      ),
    )
    .orderBy(hubThread.nextAttemptAt)
    .limit(limit);
}

/** Clears expired leases on pending threads so a crashed run is re-claimed. Returns the count. */
export async function expireLeases(db: DbOrTx = getDb()): Promise<number> {
  const res = await db.execute(sql`
    UPDATE hub_thread
    SET locked_until = NULL
    WHERE status = 'pending' AND locked_until IS NOT NULL AND locked_until < now()
    RETURNING id
  `);
  return rowsOf<{ id: string }>(res).length;
}

/** Users that have at least one due `hub_sync_item` (not leased, retry time reached). */
export async function dueSyncUsers(limit = 500, db: DbOrTx = getDb()): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: hubSyncItem.userId })
    .from(hubSyncItem)
    .where(
      and(
        sql`(${hubSyncItem.status} <> 'stored' OR ${hubSyncItem.syncedVersion} < ${hubSyncItem.version})`,
        sql`(${hubSyncItem.nextAttemptAt} IS NULL OR ${hubSyncItem.nextAttemptAt} <= now())`,
        sql`(${hubSyncItem.leaseUntil} IS NULL OR ${hubSyncItem.leaseUntil} < now())`,
        // Rows waiting for `hub.refilter` are not synced (fail-closed); `hub.refilter` wakes them.
        sql`${hubSyncItem.lastErrorCode} IS DISTINCT FROM 'refilter_pending'`,
      ),
    )
    .limit(limit);
  return rows.map((r) => r.userId);
}

/** Number of LLM calls of `purpose` by the user since `since` (daily cap check). Counters only. */
export async function llmCallsSince(
  userId: string,
  since: Date,
  purpose: 'triage' | 'extract',
  db: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(hubLlmCall)
    .where(
      and(
        eq(hubLlmCall.userId, userId),
        eq(hubLlmCall.purpose, purpose),
        gte(hubLlmCall.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Of the given blob storage keys, those that have no `hub_file` row (blob sweep). */
export async function orphanBlobKeys(keys: string[], db: DbOrTx = getDb()): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({ key: hubFile.storageKey })
    .from(hubFile)
    .where(inArray(hubFile.storageKey, keys));
  const known = new Set(rows.map((r) => r.key));
  return keys.filter((k) => !known.has(k));
}

/**
 * Distinct threads with an `extract` call for the user since `since` (a schema retry writes two rows for one
 * thread). Shared by the hub.thread daily cap and the mailbox "paused" indicator; `excludeThreadId` leaves out the
 * thread being processed.
 */
export async function countExtractedThreadsSince(
  userId: string,
  since: Date,
  excludeThreadId?: string,
  db: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${hubLlmCall.threadId})::int` })
    .from(hubLlmCall)
    .where(
      and(
        eq(hubLlmCall.userId, userId),
        eq(hubLlmCall.purpose, 'extract'),
        gte(hubLlmCall.createdAt, since),
        excludeThreadId ? sql`${hubLlmCall.threadId} is distinct from ${excludeThreadId}` : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

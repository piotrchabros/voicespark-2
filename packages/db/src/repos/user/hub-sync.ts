import { and, eq, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { getDb, type DbOrTx, type Tx } from '../../client';
import {
  hubFile,
  hubLink,
  hubNote,
  hubSyncItem,
  hubThread,
  hubThreadRecord,
  type HubSyncEntity,
  type HubSyncItem,
} from '../../schema';
import type { UserContext } from './types';

// Outbox of the memory-store copy (contracts/memory-store-hub.md "Outbox"; data-model.md "hub_sync_item").
// Every statement filters `user_id = ctx.userId`. Interval arithmetic runs in SQL so `now()` is the database's.

export type HubRecordKind = 'person' | 'company' | 'project';

export interface SyncTarget {
  entityType: HubSyncEntity;
  entityId: string;
  docId: string;
}

const DIRTY_DELAY = sql`now() + interval '2 seconds'`;

/**
 * Inserts or bumps one row per target: `version + 1`, `pending`, `attempts = 0`, due in 2 s. `deleted: true` writes
 * tombstones; otherwise `deleted` is left as it is, so a late mark never resurrects a tombstone. Targets must be
 * distinct by `docId` (one statement cannot update a row twice).
 */
export async function upsertDirty(
  ctx: UserContext,
  targets: SyncTarget[],
  tx: Tx,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  if (targets.length === 0) return;
  const deleted = opts.deleted === true;
  await tx
    .insert(hubSyncItem)
    .values(
      targets.map((t) => ({
        userId: ctx.userId,
        entityType: t.entityType,
        entityId: t.entityId,
        docId: t.docId,
        deleted,
        nextAttemptAt: DIRTY_DELAY,
      })),
    )
    .onConflictDoUpdate({
      target: [hubSyncItem.userId, hubSyncItem.docId],
      set: {
        version: sql`${hubSyncItem.version} + 1`,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: DIRTY_DELAY,
        updatedAt: sql`now()`,
        ...(deleted ? { deleted: true } : {}),
      },
    });
}

/**
 * Claims up to `limit` due rows and leases them for 120 s. The predicate matches `hub_sync_item_due_idx`; SKIP
 * LOCKED keeps concurrent claimers disjoint. Rows come back in `next_attempt_at` order.
 */
export async function claimDue(
  ctx: UserContext,
  limit: number,
  db: DbOrTx = getDb(),
): Promise<HubSyncItem[]> {
  const due = db
    .select({ id: hubSyncItem.id })
    .from(hubSyncItem)
    .where(
      and(
        eq(hubSyncItem.userId, ctx.userId),
        or(ne(hubSyncItem.status, 'stored'), lt(hubSyncItem.syncedVersion, hubSyncItem.version)),
        or(isNull(hubSyncItem.nextAttemptAt), lte(hubSyncItem.nextAttemptAt, sql`now()`)),
        or(isNull(hubSyncItem.leaseUntil), lt(hubSyncItem.leaseUntil, sql`now()`)),
        // Fail-closed: a row waiting for `hub.refilter` is never sent with content filtered under an older policy.
        sql`${hubSyncItem.lastErrorCode} is distinct from 'refilter_pending'`,
      ),
    )
    .orderBy(hubSyncItem.nextAttemptAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .update(hubSyncItem)
    .set({ leaseUntil: sql`now() + interval '120 seconds'`, updatedAt: sql`now()` })
    // `= any(array(...))` makes the locking subquery a one-shot initplan. `in (subquery)` may be planned as a
    // rescanned semi-join, which lets one claimer take more than `limit` rows.
    .where(and(eq(hubSyncItem.userId, ctx.userId), sql`${hubSyncItem.id} = any(array(${due}))`))
    .returning();
  return rows.sort(
    (a, b) => (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0),
  );
}

/**
 * `stored` with `synced_version = version` only while `version` is still the one the worker sent. Otherwise only the
 * lease is released and the row stays pending for the next pass. Returns whether the row was marked stored.
 */
export async function completeStored(
  ctx: UserContext,
  id: string,
  version: number,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const stored = await db
    .update(hubSyncItem)
    .set({
      syncedVersion: version,
      status: 'stored',
      attempts: 0,
      lastErrorCode: null,
      lastSyncedAt: sql`now()`,
      leaseUntil: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(hubSyncItem.id, id),
        eq(hubSyncItem.userId, ctx.userId),
        eq(hubSyncItem.version, version),
      ),
    )
    .returning({ id: hubSyncItem.id });
  if (stored.length > 0) return true;
  await db
    .update(hubSyncItem)
    .set({ leaseUntil: null, updatedAt: sql`now()` })
    .where(and(eq(hubSyncItem.id, id), eq(hubSyncItem.userId, ctx.userId)));
  return false;
}

/** `failed`, `attempts + 1`, retry after `min(5 s * 2^(n-1), 15 min)` +/-20% (n = the new attempt count). */
export async function markFailed(
  ctx: UserContext,
  id: string,
  errorCode: string,
  db: DbOrTx = getDb(),
): Promise<void> {
  await db
    .update(hubSyncItem)
    .set({
      status: 'failed',
      attempts: sql`${hubSyncItem.attempts} + 1`,
      lastErrorCode: errorCode,
      // SET expressions see the old row, so `attempts` here is n - 1.
      nextAttemptAt: sql`now() + make_interval(secs => least(5 * power(2, ${hubSyncItem.attempts}), 900) * (0.8 + random() * 0.4))`,
      leaseUntil: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(hubSyncItem.id, id), eq(hubSyncItem.userId, ctx.userId)));
}

/** Store busy: retry in 10 s, attempts and status unchanged. */
export async function markBusy(ctx: UserContext, id: string, db: DbOrTx = getDb()): Promise<void> {
  await db
    .update(hubSyncItem)
    .set({
      nextAttemptAt: sql`now() + interval '10 seconds'`,
      leaseUntil: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(hubSyncItem.id, id), eq(hubSyncItem.userId, ctx.userId)));
}

/**
 * Inserts a row (`ON CONFLICT DO NOTHING`) for every record, note, file and summarised thread of the user, then
 * bumps `version`, resets `attempts` and sets `pending` (due now) on every non-deleted row. Returns the bumped count.
 */
export async function backfillAndBump(ctx: UserContext, tx: Tx): Promise<number> {
  const u = ctx.userId;
  await tx.execute(sql`
    insert into hub_sync_item (user_id, entity_type, entity_id, doc_id, next_attempt_at)
    select user_id, 'person'::hub_sync_entity, id, 'hub_person_' || id, now() from hub_person where user_id = ${u}
    union all
    select user_id, 'company'::hub_sync_entity, id, 'hub_company_' || id, now() from hub_company where user_id = ${u}
    union all
    select user_id, 'project'::hub_sync_entity, id, 'hub_project_' || id, now() from hub_project where user_id = ${u}
    union all
    select user_id, 'note'::hub_sync_entity, id, 'hub_note_' || id, now() from hub_note where user_id = ${u}
    union all
    select user_id, 'file'::hub_sync_entity, id, 'hub_file_' || id, now() from hub_file where user_id = ${u}
    union all
    select user_id, 'summary'::hub_sync_entity, id, 'hub_summary_' || id, now() from hub_thread
      where user_id = ${u} and summary_enc is not null
    on conflict (user_id, doc_id) do nothing`);
  const bumped = await tx
    .update(hubSyncItem)
    .set({
      version: sql`${hubSyncItem.version} + 1`,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(hubSyncItem.userId, ctx.userId), eq(hubSyncItem.deleted, false)))
    .returning({ id: hubSyncItem.id });
  return bumped.length;
}

/** The sync row of one entity, or null when it was never marked. */
export async function getSyncItem(
  ctx: UserContext,
  docId: string,
  db: DbOrTx = getDb(),
): Promise<Pick<HubSyncItem, 'status' | 'lastSyncedAt'> | null> {
  const [row] = await db
    .select({ status: hubSyncItem.status, lastSyncedAt: hubSyncItem.lastSyncedAt })
    .from(hubSyncItem)
    .where(and(eq(hubSyncItem.userId, ctx.userId), eq(hubSyncItem.docId, docId)))
    .limit(1);
  return row ?? null;
}

export interface RecordTree {
  noteIds: string[];
  fileIds: string[];
  /** Threads with a summary attached to the record. */
  summaryThreadIds: string[];
  linked: { kind: HubRecordKind; id: string }[];
}

const NOTE_OWNER = { person: hubNote.personId, company: hubNote.companyId, project: hubNote.projectId };
const FILE_OWNER = { person: hubFile.personId, company: hubFile.companyId, project: hubFile.projectId };
const THREAD_TARGET = {
  person: hubThreadRecord.personId,
  company: hubThreadRecord.companyId,
  project: hubThreadRecord.projectId,
};
const LINK_END = { person: hubLink.personId, company: hubLink.companyId, project: hubLink.projectId };

/** Ids the fan-out of contracts/memory-store-hub.md reaches from one record. Empty for a foreign record. */
export async function recordTree(
  ctx: UserContext,
  kind: HubRecordKind,
  id: string,
  db: DbOrTx = getDb(),
): Promise<RecordTree> {
  const notes = await db
    .select({ id: hubNote.id })
    .from(hubNote)
    .where(and(eq(hubNote.userId, ctx.userId), eq(NOTE_OWNER[kind], id)));
  const files = await db
    .select({ id: hubFile.id })
    .from(hubFile)
    .where(and(eq(hubFile.userId, ctx.userId), eq(FILE_OWNER[kind], id)));
  const summaries = await db
    .selectDistinct({ id: hubThread.id })
    .from(hubThreadRecord)
    .innerJoin(hubThread, eq(hubThread.id, hubThreadRecord.threadId))
    .where(
      and(
        eq(hubThreadRecord.userId, ctx.userId),
        eq(hubThread.userId, ctx.userId),
        eq(THREAD_TARGET[kind], id),
        isNotNull(hubThread.summaryEnc),
      ),
    );
  const links = await db
    .select({ personId: hubLink.personId, companyId: hubLink.companyId, projectId: hubLink.projectId })
    .from(hubLink)
    .where(and(eq(hubLink.userId, ctx.userId), eq(LINK_END[kind], id)));
  const linked: { kind: HubRecordKind; id: string }[] = [];
  for (const l of links) {
    if (kind !== 'person' && l.personId) linked.push({ kind: 'person', id: l.personId });
    if (kind !== 'company' && l.companyId) linked.push({ kind: 'company', id: l.companyId });
    if (kind !== 'project' && l.projectId) linked.push({ kind: 'project', id: l.projectId });
  }
  return {
    noteIds: notes.map((n) => n.id),
    fileIds: files.map((f) => f.id),
    summaryThreadIds: summaries.map((s) => s.id),
    linked,
  };
}

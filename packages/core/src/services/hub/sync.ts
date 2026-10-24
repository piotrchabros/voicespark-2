import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  getDb,
  hubCompany,
  hubFile,
  hubNote,
  hubPerson,
  hubProject,
  hubSyncItem,
  hubThread,
  withTransaction,
  type DbOrTx,
  type HubSyncEntity,
  type HubSyncItem,
  type HubSyncStatus,
  type Tx,
} from '@voicespark/db';
import * as repo from '@voicespark/db/repos/user/hub-sync';
import { AppError, type ServiceContext } from '../../errors';
import { logger } from '../../logger';
import { enqueue, jobIds } from '../../queues';
import { audit } from '../audit';
import { decryptContent, type HubKind } from './common';

// Outbox of the memory-store copy (contracts/memory-store-hub.md "Outbox" and "Worker rules"; FR-025, FR-026).
// Domain writes mark rows dirty in their own transaction; the `hub.sync` worker (US7) claims and completes them.
// Postgres is the source of truth: a lost wake-up job is recovered by `maintenance.hub-sync-sweep`.

export type SyncEntityType = HubSyncEntity;
export type ClaimedSyncItem = HubSyncItem;

/** The `sync` field of record, note and file responses (contracts/http-api.md). */
export interface SyncField {
  status: HubSyncStatus;
  lastSyncedAt: string | null;
}

const WAKE_DELAY_MS = 2000;

/** `hub_{entityType}_{uuid}`; a summary uses the thread uuid. With `vs_user_{id}__` the longest id is 94 chars. */
export function docIdFor(entityType: SyncEntityType, entityId: string): string {
  return `hub_${entityType}_${entityId}`;
}

const target = (entityType: SyncEntityType, entityId: string): repo.SyncTarget => ({
  entityType,
  entityId,
  docId: docIdFor(entityType, entityId),
});

/**
 * One `hub.sync` job per user (`hubsync-{userId}`, delay 2 s). Called before the caller commits, so the delay covers
 * the commit. A Redis failure must not roll back the domain write: the sweep picks the rows up.
 */
async function wake(userId: string): Promise<void> {
  try {
    await enqueue('hub.sync', { userId }, { jobId: jobIds.hubSync(userId), delay: WAKE_DELAY_MS });
  } catch {
    logger.warn(
      { userId, errorCode: 'hub_sync_enqueue_failed' },
      'hub.sync wake-up not enqueued; sweep will retry',
    );
  }
}

/** Inserts or bumps the entity's row (`version + 1`, `pending`, due in 2 s) inside the caller's transaction. */
export async function markDirty(
  tx: Tx,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
): Promise<void> {
  await repo.upsertDirty({ userId }, [target(entityType, entityId)], tx);
  await wake(userId);
}

/** Like `markDirty`, and sets `deleted = true`: the worker removes the document. */
export async function tombstone(
  tx: Tx,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
): Promise<void> {
  await repo.upsertDirty({ userId }, [target(entityType, entityId)], tx, { deleted: true });
  await wake(userId);
}

/**
 * Fan-out of contracts/memory-store-hub.md for one record: the record, its notes and files, every linked record and
 * the summaries attached to it (rename, link change, merge: call it for each record involved). With `deleted` (call it
 * before the row is deleted, the notes and files cascade) the record, its notes and files are tombstoned and each
 * linked record's tree (record, notes, files, summaries) is marked dirty, as are the summaries of the deleted record.
 */
export async function markRecordTree(
  tx: Tx,
  userId: string,
  kind: HubKind,
  recordId: string,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  const ctx = { userId };
  const tree = await repo.recordTree(ctx, kind, recordId, tx);
  const own = [
    target(kind, recordId),
    ...tree.noteIds.map((id) => target('note', id)),
    ...tree.fileIds.map((id) => target('file', id)),
  ];
  const dirty = new Map<string, repo.SyncTarget>();
  const add = (t: repo.SyncTarget) => dirty.set(t.docId, t);
  tree.summaryThreadIds.forEach((id) => add(target('summary', id)));
  if (opts.deleted) {
    for (const l of tree.linked) {
      const sub = await repo.recordTree(ctx, l.kind, l.id, tx);
      add(target(l.kind, l.id));
      sub.noteIds.forEach((id) => add(target('note', id)));
      sub.fileIds.forEach((id) => add(target('file', id)));
      sub.summaryThreadIds.forEach((id) => add(target('summary', id)));
    }
    // The deleted record's own items are tombstones, never plain dirty marks.
    for (const t of own) dirty.delete(t.docId);
    await repo.upsertDirty(ctx, own, tx, { deleted: true });
  } else {
    own.forEach(add);
    tree.linked.forEach((l) => add(target(l.kind, l.id)));
  }
  await repo.upsertDirty(ctx, [...dirty.values()], tx);
  await wake(userId);
}

/** Claims up to `limit` due rows of the user under a 120 s lease (FOR UPDATE SKIP LOCKED). */
export async function claimDue(userId: string, limit = 10): Promise<ClaimedSyncItem[]> {
  return repo.claimDue({ userId }, limit);
}

/** Marks the row stored at `version` only if it is still at `version`; false leaves it pending for the next pass. */
export async function completeStored(
  userId: string,
  id: string,
  version: number,
): Promise<boolean> {
  return repo.completeStored({ userId }, id, version);
}

/** Store error: `failed`, `attempts + 1`, backoff `min(5 s * 2^(n-1), 15 min)` +/-20%, no maximum attempts. */
export async function fail(userId: string, id: string, errorCode: string): Promise<void> {
  await repo.markFailed({ userId }, id, errorCode);
}

/** `MemoryStoreBusyError`: retry in 10 s without counting an attempt. */
export async function busy(userId: string, id: string): Promise<void> {
  await repo.markBusy({ userId }, id);
}

/**
 * Back-fills missing rows (`ON CONFLICT DO NOTHING`) and marks every non-deleted row dirty. Never deletes the
 * namespace. Audits `hub.resync_requested {items}` in the same transaction. Returns the number of rows requeued.
 */
export async function resync(ctx: ServiceContext): Promise<number> {
  const count = await withTransaction(async (tx) => {
    const items = await repo.backfillAndBump({ userId: ctx.userId }, tx);
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'hub.resync_requested',
        targetType: 'hub',
        metadata: { items },
      },
      tx,
    );
    return items;
  });
  await wake(ctx.userId);
  return count;
}

export interface SyncStatusItem {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  /** The decrypted item name; null when the entity has none (a summary of a thread without subject). */
  label: string | null;
  status: HubSyncStatus;
  attempts: number;
  lastErrorCode: string | null;
  lastSyncedAt: string | null;
}

export interface SyncStatusQuery {
  status?: HubSyncStatus;
  cursor?: string;
  limit?: number;
}

const STATUS_DEFAULT_LIMIT = 25;
const STATUS_MAX_LIMIT = 100;
const RETRY_MAX_IDS = 500;

const statusSchema = z
  .object({
    status: z.enum(['pending', 'stored', 'failed']).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(STATUS_MAX_LIMIT).optional(),
  })
  .strict();
const retryIdsSchema = z.array(z.uuid()).max(RETRY_MAX_IDS).optional();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(field: string): AppError {
  return new AppError('validation_failed', `Invalid ${field}`, { fields: [field] });
}

function decodeStatusCursor(cursor: string): [string, string] {
  const [ts, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !ts || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(ts)))
    throw invalid('cursor');
  return [ts, id];
}

/** Decrypted names of one page of items, keyed by entity id. Every lookup filters `user_id`. */
async function labelsFor(
  ctx: ServiceContext,
  rows: { entityType: SyncEntityType; entityId: string }[],
) {
  const ids = (type: SyncEntityType) =>
    rows.filter((r) => r.entityType === type).map((r) => r.entityId);
  const db = getDb();
  const labels = new Map<string, string | null>();
  const put = (found: { id: string; enc: string | null }[]) => {
    for (const f of found) labels.set(f.id, f.enc === null ? null : decryptContent(f.enc));
  };
  for (const [type, table] of [
    ['person', hubPerson],
    ['company', hubCompany],
    ['project', hubProject],
    ['file', hubFile],
  ] as const) {
    const wanted = ids(type);
    if (wanted.length === 0) continue;
    put(
      await db
        .select({ id: table.id, enc: table.nameEnc })
        .from(table)
        .where(and(eq(table.userId, ctx.userId), inArray(table.id, wanted))),
    );
  }
  const notes = ids('note');
  if (notes.length > 0) {
    put(
      await db
        .select({ id: hubNote.id, enc: hubNote.titleEnc })
        .from(hubNote)
        .where(and(eq(hubNote.userId, ctx.userId), inArray(hubNote.id, notes))),
    );
  }
  const threads = ids('summary');
  if (threads.length > 0) {
    put(
      await db
        .select({ id: hubThread.id, enc: hubThread.subjectEnc })
        .from(hubThread)
        .where(and(eq(hubThread.userId, ctx.userId), inArray(hubThread.id, threads))),
    );
  }
  return labels;
}

/**
 * Sync status of the user's items (FR-026): counts per status and one page of items, newest change first, with the
 * decrypted label. Tombstones (`deleted = true`) are not items of the hub any more and are left out of both.
 */
export async function status(
  ctx: ServiceContext,
  query: SyncStatusQuery,
): Promise<{
  counts: Record<HubSyncStatus, number>;
  items: SyncStatusItem[];
  nextCursor: string | null;
}> {
  const parsed = statusSchema.safeParse(query);
  if (!parsed.success) throw invalid(String(parsed.error.issues[0]?.path[0] ?? 'query'));
  const q = parsed.data;
  const limit = q.limit ?? STATUS_DEFAULT_LIMIT;
  const db = getDb();
  const own = and(eq(hubSyncItem.userId, ctx.userId), eq(hubSyncItem.deleted, false));

  const counts: Record<HubSyncStatus, number> = { stored: 0, pending: 0, failed: 0 };
  const grouped = await db
    .select({ status: hubSyncItem.status, n: count() })
    .from(hubSyncItem)
    .where(own)
    .groupBy(hubSyncItem.status);
  for (const g of grouped) counts[g.status] = g.n;

  const conds = [own];
  if (q.status) conds.push(eq(hubSyncItem.status, q.status));
  if (q.cursor) {
    const [ts, id] = decodeStatusCursor(q.cursor);
    conds.push(
      sql`(${hubSyncItem.updatedAt}, ${hubSyncItem.id}) < (${ts}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await db
    .select({
      id: hubSyncItem.id,
      entityType: hubSyncItem.entityType,
      entityId: hubSyncItem.entityId,
      status: hubSyncItem.status,
      attempts: hubSyncItem.attempts,
      lastErrorCode: hubSyncItem.lastErrorCode,
      lastSyncedAt: hubSyncItem.lastSyncedAt,
      ts: sql<string>`${hubSyncItem.updatedAt}::text`,
    })
    .from(hubSyncItem)
    .where(and(...conds))
    .orderBy(desc(hubSyncItem.updatedAt), desc(hubSyncItem.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const labels = await labelsFor(ctx, page);
  const last = page.at(-1);
  return {
    counts,
    items: page.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      label: labels.get(r.entityId) ?? null,
      status: r.status,
      attempts: r.attempts,
      lastErrorCode: r.lastErrorCode,
      lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    })),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(`${last.ts}|${last.id}`, 'utf8').toString('base64url')
        : null,
  };
}

/**
 * User retry (data-model.md "hub_sync_item" states): `failed` rows go back to `pending`, `attempts = 0`, due now.
 * Without ids every failed row of the user; ids of other users or of rows that are not failed are ignored.
 * Returns the number of rows requeued.
 */
export async function retry(ctx: ServiceContext, ids?: string[]): Promise<number> {
  const parsed = retryIdsSchema.safeParse(ids);
  if (!parsed.success) throw invalid('ids');
  const conds = [eq(hubSyncItem.userId, ctx.userId), eq(hubSyncItem.status, 'failed')];
  if (parsed.data) {
    if (parsed.data.length === 0) return 0;
    conds.push(inArray(hubSyncItem.id, parsed.data));
  }
  const requeued = await getDb()
    .update(hubSyncItem)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(...conds))
    .returning({ id: hubSyncItem.id });
  if (requeued.length > 0) await wake(ctx.userId);
  return requeued.length;
}

/** `pending` with no timestamp until the entity has a row. */
export async function syncFieldFor(
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
  db?: DbOrTx,
): Promise<SyncField> {
  const row = await repo.getSyncItem({ userId }, docIdFor(entityType, entityId), db);
  return {
    status: row?.status ?? 'pending',
    lastSyncedAt: row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  };
}

/** `syncFieldFor` for many entities of one type in one query, keyed by entity id. */
export async function syncFieldsFor(
  userId: string,
  entityType: SyncEntityType,
  entityIds: string[],
  db?: DbOrTx,
): Promise<Map<string, SyncField>> {
  const rows = await repo.getSyncItems({ userId }, entityIds.map((id) => docIdFor(entityType, id)), db);
  return new Map(
    entityIds.map((id) => {
      const row = rows.get(docIdFor(entityType, id));
      const lastSyncedAt = row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null;
      return [id, { status: row?.status ?? 'pending', lastSyncedAt }];
    }),
  );
}

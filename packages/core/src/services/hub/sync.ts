import { withTransaction, type DbOrTx, type HubSyncEntity, type HubSyncItem, type HubSyncStatus, type Tx } from '@voicespark/db';
import * as repo from '@voicespark/db/repos/user/hub-sync';
import { logger } from '../../logger';
import { enqueue, jobIds } from '../../queues';
import type { HubKind } from './common';

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
    logger.warn({ userId, errorCode: 'hub_sync_enqueue_failed' }, 'hub.sync wake-up not enqueued; sweep will retry');
  }
}

/** Inserts or bumps the entity's row (`version + 1`, `pending`, due in 2 s) inside the caller's transaction. */
export async function markDirty(tx: Tx, userId: string, entityType: SyncEntityType, entityId: string): Promise<void> {
  await repo.upsertDirty({ userId }, [target(entityType, entityId)], tx);
  await wake(userId);
}

/** Like `markDirty`, and sets `deleted = true`: the worker removes the document. */
export async function tombstone(tx: Tx, userId: string, entityType: SyncEntityType, entityId: string): Promise<void> {
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
export async function completeStored(userId: string, id: string, version: number): Promise<boolean> {
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
 * namespace. Returns the number of rows requeued.
 */
export async function resync(userId: string): Promise<number> {
  const count = await withTransaction((tx) => repo.backfillAndBump({ userId }, tx));
  await wake(userId);
  return count;
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

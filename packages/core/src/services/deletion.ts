import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  connectedSource,
  contentItem,
  contentItemOccurrence,
  deletionRequest,
  exclusionReport,
  getDb,
  importJob,
  mailboxCredential,
  retroscan,
  session,
  upload,
  user,
  withTransaction,
  type DbOrTx,
  type DeletionRequest,
  type DeletionRequestedBy,
  type DeletionScope,
  type DeletionStatus,
  type Tx,
} from '@voicespark/db';
import { revokeGoogleToken } from '@voicespark/integrations/oauth';
import { renderAccountDeletedEmail } from '@voicespark/integrations/smtp';
import {
  META,
  memoryFilter,
  namespaceFor,
  type MemoryMetadata,
  type MemoryStore,
} from '@voicespark/integrations/supermemory';
import { decrypt, encrypt, subjectRef } from '../crypto';
import { loadEnv } from '../env';
import { AppError, type ServiceContext } from '../errors';
import { QUEUES, enqueue, jobIds, removeScheduler } from '../queues';
import { assertNotLastActiveAdmin } from './admin-users';
import { audit } from './audit';
import { loadRevocableToken } from './mail-access';
import { notify } from './notifications';

/** Constitution: every deletion completes and is verified within 24 h (SC-009, R19). */
export const DELETION_SLA_MS = 24 * 60 * 60 * 1000;
/** Supermemory accepts 1-100 ids per delete call. */
export const DELETE_CHUNK_SIZE = 100;
/** Source deletion waits for a running import: 30 s per wait, at most 10 waits (T049, D7). */
export const SOURCE_WAIT_DELAY_MS = 30_000;
export const SOURCE_WAIT_MAX = 10;
/** Account deletion waits for running imports the same way (same 30 s re-delay). */
export const ACCOUNT_WAIT_MAX = 10;
/** Late-write sweep for source deletions runs once, 60 s after completion. */
export const VERIFY_SWEEP_DELAY_MS = 60_000;

const LIST_PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A deletion failure with a code safe to store and log. Non-retryable codes fail the request at once. */
export class DeletionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'DeletionError';
  }
}

export interface RequestDeletionInput {
  userId: string;
  scope: DeletionScope;
  targetId?: string | null;
  requestedBy: DeletionRequestedBy;
  /** Captured for account deletion only; stored encrypted (R19 step 8). */
  notifyEmail?: string;
}

/**
 * Inserts the request (`due_by = requested_at + 24 h`) and enqueues `deletion.execute` with job id `deletion-{id}`.
 * Callers inside a transaction should commit first: the job retries until the row is visible.
 */
export async function requestDeletion(
  input: RequestDeletionInput,
  db: DbOrTx = getDb(),
): Promise<{ id: string }> {
  const requestedAt = new Date();
  const [row] = await db
    .insert(deletionRequest)
    .values({
      userId: input.userId,
      subjectRef: subjectRef(input.userId),
      scope: input.scope,
      targetId: input.targetId ?? null,
      requestedBy: input.requestedBy,
      requestedAt,
      dueBy: new Date(requestedAt.getTime() + DELETION_SLA_MS),
      notifyEmailEnc: input.notifyEmail ? encrypt('user-content', input.notifyEmail) : null,
    })
    .returning({ id: deletionRequest.id });
  if (!row) throw new Error('deletion_request_insert_failed');
  await enqueue(
    'deletion.execute',
    { deletionRequestId: row.id },
    { jobId: jobIds.deletion(row.id) },
  );
  return { id: row.id };
}

export async function getDeletion(
  id: string,
  db: DbOrTx = getDb(),
): Promise<DeletionRequest | null> {
  const [row] = await db.select().from(deletionRequest).where(eq(deletionRequest.id, id)).limit(1);
  return row ?? null;
}

/** Owner view of a deletion request (GET /api/deletions/{id}); never the notify address or error codes. */
export interface DeletionView {
  id: string;
  scope: DeletionScope;
  status: DeletionStatus;
  requestedAt: string;
  dueBy: string;
  completedAt: string | null;
}

export async function getForUser(ctx: ServiceContext, id: string): Promise<DeletionView> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  const [row] = await getDb()
    .select()
    .from(deletionRequest)
    .where(and(eq(deletionRequest.id, id), eq(deletionRequest.userId, ctx.userId)))
    .limit(1);
  if (!row) throw new AppError('not_found');
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    dueBy: row.dueBy.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/**
 * Account deletion request (T142, R19 step 1): the user becomes `pending_deletion`, every session is revoked and
 * an `account` request is queued with the address captured for the confirmation email. Idempotent while pending.
 * The last active admin is refused (`last_admin`, 409) with nothing changed.
 */
export async function requestAccountDeletion(
  ctx: ServiceContext,
): Promise<{ deletionRequestId: string }> {
  return withTransaction(async (tx) => {
    const [current] = await tx
      .select({ role: user.role, status: user.status })
      .from(user)
      .where(eq(user.id, ctx.userId))
      .limit(1);
    if (!current) throw new AppError('not_found');
    // Same lock order as admin-users.lockTarget: the active admin set first, then the target row.
    if (current.role === 'admin' && current.status === 'active')
      await assertNotLastActiveAdmin(tx, ctx.userId);
    const [locked] = await tx
      .select({ email: user.email, status: user.status })
      .from(user)
      .where(eq(user.id, ctx.userId))
      .for('update');
    if (!locked) throw new AppError('not_found');

    if (locked.status === 'pending_deletion') {
      const [pending] = await tx
        .select({ id: deletionRequest.id })
        .from(deletionRequest)
        .where(
          and(
            eq(deletionRequest.targetId, ctx.userId),
            eq(deletionRequest.scope, 'account'),
            ne(deletionRequest.status, 'completed'),
          ),
        )
        .orderBy(desc(deletionRequest.requestedAt), desc(deletionRequest.id))
        .limit(1);
      if (pending) return { deletionRequestId: pending.id };
    }

    const now = new Date();
    await tx
      .update(user)
      .set({ status: 'pending_deletion', updatedAt: now })
      .where(eq(user.id, ctx.userId));
    await tx.delete(session).where(eq(session.userId, ctx.userId));
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'account.deletion_requested',
        targetType: 'user',
        targetId: ctx.userId,
        subjectRef: subjectRef(ctx.userId),
      },
      tx,
    );
    // The job retries `request_not_found` until this transaction commits (same as every other scope).
    const { id } = await requestDeletion(
      {
        userId: ctx.userId,
        scope: 'account',
        targetId: ctx.userId,
        requestedBy: 'user',
        notifyEmail: locked.email,
      },
      tx,
    );
    return { deletionRequestId: id };
  });
}

/** Side effects of the account scope the worker wires in; tests inject fakes. */
export interface DeletionDeps {
  mailer?: { send(msg: { to: string; subject: string; text: string }): Promise<void> };
  /** Default: `@voicespark/integrations/oauth` revokeGoogleToken. */
  revokeGoogleToken?: (token: string) => Promise<void>;
  /** Default: `loadEnv().APP_URL`. */
  appUrl?: string;
}

export type DeletionRunResult =
  /** Request finished now; for `source` the caller schedules the late-write sweep. */
  | { outcome: 'completed'; scope: DeletionScope; deletedCount: number }
  /** Already completed `source` request: only the `vs_source_ids arrayContains` sweep ran. */
  | { outcome: 'swept'; deletedCount: number }
  /** Already completed, nothing to do (idempotent re-run). */
  | { outcome: 'noop' }
  /** Source (or one of the account's sources) has a running import; the caller re-delays the same job. */
  | { outcome: 'wait_import' };

/**
 * Runs one attempt of a deletion request (jobs contract 6, R19). Idempotent: deleting already-deleted ids
 * succeeds and every Supermemory step is verified before Postgres rows go.
 * `waitCount` is the number of import waits already spent (D7); `deps` are only used by the account scope.
 */
export async function executeDeletion(
  id: string,
  store: MemoryStore,
  opts: { waitCount?: number; deps?: DeletionDeps } = {},
): Promise<DeletionRunResult> {
  const db = getDb();
  const row = await getDeletion(id, db);
  // Not visible yet (enqueued before the caller committed) or never written: retry with backoff.
  if (!row) throw new DeletionError('request_not_found', true);

  if (row.status === 'completed') {
    if (row.scope !== 'source' || !row.userId || !row.targetId) return { outcome: 'noop' };
    const deletedCount = await sweepSourceDocuments(store, row.userId, row.targetId, new Map());
    await verifySourceGone(store, row.userId, row.targetId);
    if (deletedCount > 0) {
      await db
        .update(deletionRequest)
        .set({
          supermemoryDeletedCount: sql`${deletionRequest.supermemoryDeletedCount} + ${deletedCount}`,
        })
        .where(eq(deletionRequest.id, id));
    }
    return { outcome: 'swept', deletedCount };
  }

  // The account scope runs before the `!row.userId` shortcut: the user id survives the cascade in target_id.
  if (row.scope === 'account') {
    if (!row.targetId) throw new DeletionError('missing_target', false);
    return deleteAccount(store, row, row.targetId, opts.waitCount ?? 0, opts.deps ?? {});
  }

  if (row.scope === 'source' && row.targetId && (await hasRunningImport(row.targetId))) {
    if ((opts.waitCount ?? 0) < SOURCE_WAIT_MAX) return { outcome: 'wait_import' };
    throw new DeletionError('source_import_running', true);
  }

  await markInProgress(db, id);

  // The user row is gone (account deletion cascaded everything): nothing left to delete.
  if (!row.userId) {
    await markCompleted(db, id, 0);
    return { outcome: 'completed', scope: row.scope, deletedCount: 0 };
  }
  if (!row.targetId) throw new DeletionError('missing_target', false);

  const deletedCount = await runScope(store, row, row.userId, row.targetId);
  return { outcome: 'completed', scope: row.scope, deletedCount };
}

/** Records the error code; a final failure (non-retryable or out of attempts) sets `failed`. */
export async function recordDeletionFailure(
  id: string,
  errorCode: string,
  final: boolean,
): Promise<void> {
  await getDb()
    .update(deletionRequest)
    .set(final ? { status: 'failed', lastErrorCode: errorCode } : { lastErrorCode: errorCode })
    .where(and(eq(deletionRequest.id, id), ne(deletionRequest.status, 'completed')));
}

function runScope(
  store: MemoryStore,
  row: DeletionRequest,
  userId: string,
  targetId: string,
): Promise<number> {
  switch (row.scope) {
    case 'content_item':
      return deleteContentItem(store, row, userId, targetId);
    case 'source':
      return deleteSource(store, row, userId, targetId);
    case 'exclusion_report':
      return purgeExclusionReport(store, row, userId, targetId);
    case 'retroscan_purge':
      return purgeRetroscan(store, row, userId, targetId);
    default:
      throw new DeletionError('not_implemented', false);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// content_item scope

async function deleteContentItem(
  store: MemoryStore,
  row: DeletionRequest,
  userId: string,
  itemId: string,
): Promise<number> {
  const ids = await withChildren(getDb(), userId, [itemId]);
  return purgeItems(store, row, userId, ids, async (tx) => {
    if (ids.length === 0) return;
    // Upload rows pointing at the purged items go with them (D-U5 symmetry).
    await tx
      .delete(upload)
      .where(and(eq(upload.userId, userId), inArray(upload.contentItemId, ids)));
    await auditPurged(tx, row, userId, { type: 'content_item', id: itemId }, ids.length);
  });
}

/**
 * Item ids plus their attachments. Attachments are separate documents whose rows cascade with the parent,
 * so their documents are deleted too.
 */
async function withChildren(db: DbOrTx, userId: string, itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const children = await db
    .select({ id: contentItem.id })
    .from(contentItem)
    .where(and(inArray(contentItem.parentItemId, itemIds), eq(contentItem.userId, userId)));
  return [...new Set([...itemIds, ...children.map((c) => c.id)])];
}

/**
 * Shared item purge (content_item, exclusion_report, retroscan_purge): marks the rows `pending_deletion`,
 * deletes the documents in chunks, verifies each one is gone, then in one transaction runs the scope's
 * `finalize`, decrements source item counts, deletes the rows and completes the request. Returns deleted count.
 */
async function purgeItems(
  store: MemoryStore,
  row: DeletionRequest,
  userId: string,
  ids: string[],
  finalize: (tx: Tx) => Promise<void>,
): Promise<number> {
  const ns = namespaceFor(userId);
  if (ids.length > 0) {
    await getDb()
      .update(contentItem)
      .set({ status: 'pending_deletion' })
      .where(and(inArray(contentItem.id, ids), eq(contentItem.userId, userId)));
  }

  const deletedCount = await deleteDocuments(store, ns, ids);
  for (const docId of ids) {
    if (await store.getDocument(ns, docId)) throw new DeletionError('verify_failed', true);
  }

  await withTransaction(async (tx) => {
    // `finalize` runs while the rows still exist (upload.content_item_id is nulled by the cascade otherwise).
    await finalize(tx);
    if (ids.length > 0) {
      await decrementSourceItemCounts(tx, ids);
      await tx
        .delete(contentItem)
        .where(and(inArray(contentItem.id, ids), eq(contentItem.userId, userId)));
    }
    await completeRequest(tx, row, userId, deletedCount);
  });
  return deletedCount;
}

async function auditPurged(
  tx: Tx,
  row: DeletionRequest,
  userId: string,
  target: { type: 'content_item' | 'exclusion_report' | 'retroscan'; id: string },
  count: number,
): Promise<void> {
  await audit.record(
    {
      actorType: row.requestedBy,
      actorUserId: row.requestedBy === 'user' ? userId : null,
      action: 'content.purged',
      targetType: target.type,
      targetId: target.id,
      subjectRef: row.subjectRef,
      metadata: { scope: row.scope, count },
    },
    tx,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// exclusion_report scope (FR-022)

async function purgeExclusionReport(
  store: MemoryStore,
  row: DeletionRequest,
  userId: string,
  reportId: string,
): Promise<number> {
  const db = getDb();
  const [report] = await db
    .select({ id: exclusionReport.id, contentItemId: exclusionReport.contentItemId })
    .from(exclusionReport)
    .where(and(eq(exclusionReport.id, reportId), eq(exclusionReport.userId, userId)))
    .limit(1);
  if (!report) throw new DeletionError('missing_target', false);

  // The item is already gone (deleted on its own, or an earlier attempt finished the purge).
  const ids = report.contentItemId ? await withChildren(db, userId, [report.contentItemId]) : [];
  return purgeItems(store, row, userId, ids, async (tx) => {
    await tx
      .update(exclusionReport)
      .set({
        status: 'purged',
        purgedAt: sql`coalesce(${exclusionReport.purgedAt}, now())`,
        contentItemId: null,
      })
      .where(eq(exclusionReport.id, reportId));
    if (ids.length > 0) {
      await auditPurged(tx, row, userId, { type: 'exclusion_report', id: reportId }, ids.length);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// retroscan_purge scope (FR-021)

async function purgeRetroscan(
  store: MemoryStore,
  row: DeletionRequest,
  userId: string,
  retroscanId: string,
): Promise<number> {
  const db = getDb();
  const [scan] = await db
    .select({ id: retroscan.id, matchedItemIds: retroscan.matchedItemIds })
    .from(retroscan)
    .where(and(eq(retroscan.id, retroscanId), eq(retroscan.userId, userId)))
    .limit(1);
  if (!scan) throw new DeletionError('missing_target', false);

  // Matches deleted since the scan (or by an earlier attempt) are skipped.
  const existing =
    scan.matchedItemIds.length === 0
      ? []
      : await db
          .select({ id: contentItem.id })
          .from(contentItem)
          .where(and(eq(contentItem.userId, userId), inArray(contentItem.id, scan.matchedItemIds)));
  const ids = await withChildren(
    db,
    userId,
    existing.map((e) => e.id),
  );
  return purgeItems(store, row, userId, ids, async (tx) => {
    await tx.update(retroscan).set({ status: 'completed' }).where(eq(retroscan.id, retroscanId));
    await auditPurged(tx, row, userId, { type: 'retroscan', id: retroscanId }, ids.length);
  });
}

async function decrementSourceItemCounts(tx: Tx, itemIds: string[]): Promise<void> {
  const counts = await tx
    .select({ sourceId: contentItemOccurrence.sourceId, n: sql<number>`count(*)::int` })
    .from(contentItemOccurrence)
    .where(inArray(contentItemOccurrence.contentItemId, itemIds))
    .groupBy(contentItemOccurrence.sourceId);
  for (const { sourceId, n } of counts) {
    await tx
      .update(connectedSource)
      .set({ itemCount: sql`greatest(${connectedSource.itemCount} - ${n}, 0)` })
      .where(eq(connectedSource.id, sourceId));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// source scope

async function hasRunningImport(sourceId: string): Promise<boolean> {
  const [running] = await getDb()
    .select({ id: importJob.id })
    .from(importJob)
    .where(and(eq(importJob.sourceId, sourceId), eq(importJob.status, 'running')))
    .limit(1);
  return running !== undefined;
}

async function deleteSource(
  store: MemoryStore,
  row: DeletionRequest,
  userId: string,
  sourceId: string,
): Promise<number> {
  const db = getDb();
  const ns = namespaceFor(userId);
  await removeScheduler(QUEUES.syncPoll, jobIds.poll(sourceId));

  const occurrences = await db
    .select({
      itemId: contentItemOccurrence.contentItemId,
      sourceId: contentItemOccurrence.sourceId,
    })
    .from(contentItemOccurrence)
    .innerJoin(contentItem, eq(contentItem.id, contentItemOccurrence.contentItemId))
    .where(
      and(
        eq(contentItem.userId, userId),
        inArray(
          contentItemOccurrence.contentItemId,
          db
            .select({ id: contentItemOccurrence.contentItemId })
            .from(contentItemOccurrence)
            .where(eq(contentItemOccurrence.sourceId, sourceId)),
        ),
      ),
    );

  // Items whose only remaining occurrence is this source are deleted; the rest keep their other sources.
  const otherSources = new Map<string, Set<string>>();
  for (const o of occurrences) {
    const others = otherSources.get(o.itemId) ?? new Set<string>();
    if (o.sourceId !== sourceId) others.add(o.sourceId);
    otherSources.set(o.itemId, others);
  }
  const exclusive = [...otherSources]
    .filter(([, others]) => others.size === 0)
    .map(([itemId]) => itemId);
  const shared = new Map(
    [...otherSources]
      .filter(([, others]) => others.size > 0)
      .map(([itemId, others]) => [itemId, [...others]]),
  );

  // Attachments without an occurrence of their own go with an exclusive parent.
  if (exclusive.length > 0) {
    const orphanChildren = await db
      .select({ id: contentItem.id })
      .from(contentItem)
      .leftJoin(contentItemOccurrence, eq(contentItemOccurrence.contentItemId, contentItem.id))
      .where(
        and(
          eq(contentItem.userId, userId),
          inArray(contentItem.parentItemId, exclusive),
          isNull(contentItemOccurrence.id),
        ),
      );
    for (const c of orphanChildren) if (!exclusive.includes(c.id)) exclusive.push(c.id);
  }

  if (exclusive.length > 0) {
    await db
      .update(contentItem)
      .set({ status: 'pending_deletion' })
      .where(and(inArray(contentItem.id, exclusive), eq(contentItem.userId, userId)));
  }

  let deletedCount = await deleteDocuments(store, ns, exclusive);
  // Shared documents get their narrowed vs_source_ids; anything else still tagged with this source is deleted.
  deletedCount += await sweepSourceDocuments(store, userId, sourceId, shared);
  await verifySourceGone(store, userId, sourceId);

  await withTransaction(async (tx) => {
    if (exclusive.length > 0) {
      await tx
        .delete(contentItem)
        .where(and(inArray(contentItem.id, exclusive), eq(contentItem.userId, userId)));
    }
    await tx.delete(contentItemOccurrence).where(eq(contentItemOccurrence.sourceId, sourceId));
    await tx
      .delete(connectedSource)
      .where(and(eq(connectedSource.id, sourceId), eq(connectedSource.userId, userId)));
    await audit.record(
      {
        // deletion_requested_by and audit_actor_type share the same values.
        actorType: row.requestedBy,
        actorUserId: row.requestedBy === 'user' ? userId : null,
        action: 'source.deleted',
        targetType: 'connected_source',
        targetId: sourceId,
        subjectRef: row.subjectRef,
        metadata: { deletedItems: exclusive.length, updatedItems: shared.size },
      },
      tx,
    );
    await completeRequest(tx, row, userId, deletedCount);
  });
  return deletedCount;
}

/**
 * Handles every document still tagged with `sourceId`: narrows `vs_source_ids` where other sources remain
 * (from Postgres via `shared`, else from the document's own metadata), deletes the rest. Returns deleted count.
 */
async function sweepSourceDocuments(
  store: MemoryStore,
  userId: string,
  sourceId: string,
  shared: Map<string, string[]>,
): Promise<number> {
  const ns = namespaceFor(userId);
  const tagged = await listAllTagged(store, ns, sourceId);
  const toDelete: string[] = [];
  for (const doc of tagged) {
    const remaining = shared.get(doc.id) ?? remainingSourceIds(doc.metadata, sourceId);
    if (remaining.length === 0) {
      toDelete.push(doc.id);
    } else {
      await store.updateDocumentMetadata(ns, doc.id, {
        ...doc.metadata,
        [META.sourceIds]: remaining,
      });
    }
  }
  const deletedCount = await deleteDocuments(store, ns, toDelete);
  if (toDelete.length > 0) {
    // Late writes may have left a content_item row with no occurrence behind.
    const db = getDb();
    await db
      .delete(contentItem)
      .where(
        and(
          eq(contentItem.userId, userId),
          inArray(contentItem.id, toDelete),
          sql`not exists (select 1 from ${contentItemOccurrence} where ${contentItemOccurrence.contentItemId} = ${contentItem.id})`,
        ),
      );
  }
  return deletedCount;
}

async function verifySourceGone(
  store: MemoryStore,
  userId: string,
  sourceId: string,
): Promise<void> {
  const left = await store.listDocuments(namespaceFor(userId), {
    filter: memoryFilter.arrayContains(META.sourceIds, sourceId),
    page: 1,
    limit: 1,
  });
  if (left.documents.length > 0) throw new DeletionError('verify_failed', true);
}

async function listAllTagged(
  store: MemoryStore,
  ns: string,
  sourceId: string,
): Promise<{ id: string; metadata: MemoryMetadata }[]> {
  const filter = memoryFilter.arrayContains(META.sourceIds, sourceId);
  const docs: { id: string; metadata: MemoryMetadata }[] = [];
  // Collect every page before mutating so deletes do not shift the pagination.
  for (let page = 1; ; page++) {
    const res = await store.listDocuments(ns, { filter, page, limit: LIST_PAGE_SIZE });
    docs.push(...res.documents);
    if (!res.hasMore || res.documents.length === 0) break;
  }
  return docs;
}

function remainingSourceIds(metadata: MemoryMetadata, sourceId: string): string[] {
  const value = metadata[META.sourceIds];
  return Array.isArray(value) ? value.filter((s) => s !== sourceId) : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// account scope (T142, R19, D-U7a)

/**
 * Every step is idempotent so a retry after a partial run resumes where it stopped:
 * 1. while the user row exists: disconnect sources (wait for running imports), revoke/delete credentials,
 *    delete + verify the namespace, delete the user row (everything owned cascades);
 * 2. while `notify_email_enc` is set: send the confirmation and null the address (the "sent" marker);
 * 3. pseudonymize the audit log, write `account.deleted` and complete the request.
 */
async function deleteAccount(
  store: MemoryStore,
  row: DeletionRequest,
  userId: string,
  waitCount: number,
  deps: DeletionDeps,
): Promise<DeletionRunResult> {
  const db = getDb();
  const ns = namespaceFor(userId);
  let deletedDocuments = 0;

  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (existing) {
    const sources = await db
      .select({ id: connectedSource.id, type: connectedSource.type })
      .from(connectedSource)
      .where(eq(connectedSource.userId, userId));
    const sourceIds = sources.map((s) => s.id);
    // Stop syncing first so no new page can be enqueued while we wait for in-flight ones (D-U7a).
    await db
      .update(connectedSource)
      .set({
        status: 'disconnected',
        pauseReason: null,
        disconnectedAt: sql`coalesce(${connectedSource.disconnectedAt}, now())`,
      })
      .where(and(eq(connectedSource.userId, userId), ne(connectedSource.status, 'disconnected')));
    await db
      .update(importJob)
      .set({ status: 'cancelled', pauseReason: null, finishedAt: new Date() })
      .where(and(eq(importJob.userId, userId), inArray(importJob.status, ['queued', 'paused'])));
    for (const sourceId of sourceIds) await removeScheduler(QUEUES.syncPoll, jobIds.poll(sourceId));
    const [running] = await db
      .select({ id: importJob.id })
      .from(importJob)
      .where(and(eq(importJob.userId, userId), eq(importJob.status, 'running')))
      .limit(1);
    if (running) {
      if (waitCount < ACCOUNT_WAIT_MAX) return { outcome: 'wait_import' };
      throw new DeletionError('account_import_running', true);
    }
    await markInProgress(db, row.id);

    // Google tokens are revoked best effort; Microsoft has no revoke endpoint, so every credential is just deleted.
    const revoke = deps.revokeGoogleToken ?? revokeGoogleToken;
    for (const source of sources) {
      if (source.type !== 'gmail') continue;
      const token = await loadRevocableToken(source.id, db).catch(() => null);
      if (token) await revoke(token).catch(() => undefined);
    }
    if (sourceIds.length > 0) {
      await db.delete(mailboxCredential).where(inArray(mailboxCredential.sourceId, sourceIds));
    }

    // One document per item row: counted before the namespace goes (the metadata is a count only).
    const [items] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItem)
      .where(eq(contentItem.userId, userId));
    deletedDocuments = items?.n ?? 0;
    await store.deleteNamespace(ns);
    if (!(await namespaceEmpty(store, ns))) throw new DeletionError('verify_failed', true);

    await db.delete(user).where(eq(user.id, userId));
  } else {
    await markInProgress(db, row.id);
  }

  const [current] = await db
    .select({ notifyEmailEnc: deletionRequest.notifyEmailEnc })
    .from(deletionRequest)
    .where(eq(deletionRequest.id, row.id))
    .limit(1);
  if (current?.notifyEmailEnc) {
    if (!deps.mailer) throw new DeletionError('mailer_unavailable', true);
    const to = decrypt('user-content', current.notifyEmailEnc);
    await deps.mailer.send({ to, ...renderAccountDeletedEmail(deps.appUrl ?? loadEnv().APP_URL) });
    await db
      .update(deletionRequest)
      .set({ notifyEmailEnc: null })
      .where(eq(deletionRequest.id, row.id));
  }

  await withTransaction(async (tx) => {
    await audit.pseudonymize(userId, tx);
    await audit.record(
      {
        actorType: 'user',
        actorUserId: null,
        action: 'account.deleted',
        targetType: 'user',
        subjectRef: row.subjectRef,
        metadata: { deletedDocuments },
      },
      tx,
    );
    await markCompleted(tx, row.id, deletedDocuments);
  });
  return { outcome: 'completed', scope: 'account', deletedCount: deletedDocuments };
}

/**
 * R19 verify step after `deleteNamespace`: only a not-found (404) counts as empty. Detected structurally
 * (error name + status/code) so auth failures and the foreign-document guard still propagate.
 */
export async function namespaceEmpty(store: MemoryStore, ns: string): Promise<boolean> {
  try {
    const res = await store.listDocuments(ns, { page: 1, limit: 1 });
    return res.documents.length === 0;
  } catch (err) {
    const e = err as { name?: unknown; status?: unknown; code?: unknown } | null;
    if (
      e?.name === 'MemoryStoreHttpError' &&
      (e.status === 404 || e.code === 'supermemory_not_found')
    ) {
      return true;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// shared helpers

/** Completes the request; user-requested item and source deletions get an in-app `deletion_completed` (D-U7c). */
async function completeRequest(
  tx: Tx,
  row: DeletionRequest,
  userId: string,
  deletedCount: number,
): Promise<void> {
  if (row.requestedBy === 'user' && (row.scope === 'content_item' || row.scope === 'source')) {
    await notify(userId, 'deletion_completed', { deletionRequestId: row.id, scope: row.scope }, tx);
  }
  await markCompleted(tx, row.id, deletedCount);
}

/** Deletes in chunks of 100; failed ids are retried once, then the attempt fails (retried by the job). */
async function deleteDocuments(store: MemoryStore, ns: string, ids: string[]): Promise<number> {
  let count = 0;
  for (let i = 0; i < ids.length; i += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + DELETE_CHUNK_SIZE);
    const first = await store.deleteDocuments(ns, chunk);
    count += first.count;
    if (first.errors.length === 0) continue;
    const retry = await store.deleteDocuments(
      ns,
      first.errors.map((e) => e.id),
    );
    count += retry.count;
    if (retry.errors.length > 0) throw new DeletionError('supermemory_delete_failed', true);
  }
  return count;
}

async function markInProgress(db: DbOrTx, id: string): Promise<void> {
  await db
    .update(deletionRequest)
    .set({
      status: 'in_progress',
      attempts: sql`${deletionRequest.attempts} + 1`,
      startedAt: sql`coalesce(${deletionRequest.startedAt}, now())`,
    })
    .where(eq(deletionRequest.id, id));
}

async function markCompleted(db: DbOrTx, id: string, deletedCount: number): Promise<void> {
  await db
    .update(deletionRequest)
    .set({
      status: 'completed',
      completedAt: new Date(),
      lastErrorCode: null,
      supermemoryDeletedCount: sql`${deletionRequest.supermemoryDeletedCount} + ${deletedCount}`,
    })
    .where(eq(deletionRequest.id, id));
}

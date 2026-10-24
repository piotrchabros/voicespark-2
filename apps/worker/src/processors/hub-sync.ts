import { DelayedError, type Job } from 'bullmq';
import { and, eq, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { getDb, hubSyncItem, user } from '@voicespark/db';
import { toErrorCode } from '@voicespark/core/error-code';
import { jobLogger } from '@voicespark/core/logger';
import type { JobPayload } from '@voicespark/core/queues';
import { buildDocumentFor } from '@voicespark/core/services/hub/doc-builder';
import * as outbox from '@voicespark/core/services/hub/sync';
import {
  MemoryStoreAuthError,
  MemoryStoreBusyError,
  MemoryStoreHttpError,
  namespaceFor,
} from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';

// `hub.sync` (T082, contracts/jobs.md (13), contracts/memory-store-hub.md "Worker rules"; FR-025, FR-026, SC-010).
// Postgres is the source of truth: each claimed row is rebuilt from the current rows, written or deleted, and marked
// stored only if its `version` did not move meanwhile. Rows own their retries (no maximum attempts); the job re-delays
// itself (same id, so at most one wake-up per user) while rows are due. Logs carry ids, counts and codes only.

export const SYNC_BATCH_SIZE = 10;
/** Batches per run before the job yields; the re-delay picks up the rest. */
export const SYNC_MAX_BATCHES = 20;
export const SYNC_REQUEUE_DELAY_MS = 2_000;

export interface HubSyncResult {
  stored: number;
  deleted: number;
  /** Written, but `version` moved during the write: left pending for the next pass. */
  changed: number;
  failed: number;
  busy: number;
}

type HubSyncJob = Job<JobPayload<'hub.sync'>, unknown, 'hub.sync'>;
type ClaimedItem = outbox.ClaimedSyncItem;

export function createHubSyncHandler(overrides: Partial<WorkerDeps> = {}): Handler<'hub.sync'> {
  let deps: WorkerDeps | undefined;
  return async (job, token) => {
    deps ??= defaultDeps(overrides);
    return runSync(job, token, deps);
  };
}

async function userActive(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.status === 'active';
}

/** Unsettled, unleased rows due now or within the re-delay (never `refilter_pending`). Later backoffs: the sweep. */
async function dueSoon(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: hubSyncItem.id })
    .from(hubSyncItem)
    .where(
      and(
        eq(hubSyncItem.userId, userId),
        or(ne(hubSyncItem.status, 'stored'), lt(hubSyncItem.syncedVersion, hubSyncItem.version)),
        or(
          isNull(hubSyncItem.nextAttemptAt),
          lte(hubSyncItem.nextAttemptAt, sql`now() + make_interval(secs => ${SYNC_REQUEUE_DELAY_MS / 1000})`),
        ),
        or(isNull(hubSyncItem.leaseUntil), lt(hubSyncItem.leaseUntil, sql`now()`)),
        sql`${hubSyncItem.lastErrorCode} is distinct from 'refilter_pending'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** A delete the store refused; `code` follows the store error codes (`supermemory_http_500`, ...). */
class DeleteFailed extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Store error codes of contracts/memory-store-hub.md (`supermemory_http_500`, `supermemory_network`, ...). */
function storeErrorCode(err: unknown): string {
  if (err instanceof MemoryStoreAuthError) return 'memory_store_auth';
  if (err instanceof MemoryStoreHttpError || err instanceof DeleteFailed) return err.code;
  return toErrorCode(err);
}

/** Removes the document; a missing document is success. `still_processing` means the store is busy. */
async function removeDocument(deps: WorkerDeps, ns: string, docId: string): Promise<void> {
  const { errors } = await deps.store.deleteDocuments(ns, [docId]);
  const err = errors[0]?.error;
  if (err === undefined || err === 'supermemory_not_found') return;
  if (err === 'still_processing') throw new MemoryStoreBusyError('deleteDocuments');
  throw new DeleteFailed(toErrorCode(new Error(/^http_\d{3}$/.test(err) ? `supermemory_${err}` : err)));
}

async function syncOne(
  deps: WorkerDeps,
  userId: string,
  item: ClaimedItem,
  counts: HubSyncResult,
): Promise<void> {
  const ns = namespaceFor(userId);
  try {
    const doc = item.deleted
      ? null
      : await buildDocumentFor(userId, item.entityType, item.entityId, {
          version: item.version,
          classifier: deps.classifier,
        });
    // A tombstone, or an entity that is gone without one: the document is removed.
    if (doc === null) await removeDocument(deps, ns, item.docId);
    else await deps.store.addDocuments(ns, [doc]);
    if (await outbox.completeStored(userId, item.id, item.version)) {
      if (doc === null) counts.deleted++;
      else counts.stored++;
    } else counts.changed++;
  } catch (err) {
    if (err instanceof MemoryStoreBusyError) {
      await outbox.busy(userId, item.id);
      counts.busy++;
      return;
    }
    await outbox.fail(userId, item.id, storeErrorCode(err));
    counts.failed++;
  }
}

async function runSync(job: HubSyncJob, token: string | undefined, deps: WorkerDeps): Promise<HubSyncResult> {
  const { userId } = job.data;
  const log = jobLogger(job.id ?? userId, { userId });
  const counts: HubSyncResult = { stored: 0, deleted: 0, changed: 0, failed: 0, busy: 0 };
  // A user being deleted is handled by the namespace delete; nothing is written for them.
  if (!(await userActive(userId))) {
    log.info({ status: 'skipped' });
    return counts;
  }

  for (let batch = 0; batch < SYNC_MAX_BATCHES; batch++) {
    const items = await outbox.claimDue(userId, SYNC_BATCH_SIZE);
    for (const item of items) await syncOne(deps, userId, item, counts);
    if (items.length < SYNC_BATCH_SIZE) break;
  }
  log.info({ status: 'synced', counts: { ...counts } });

  if (await dueSoon(userId)) {
    // Same job id, re-delayed: wake-ups that arrive meanwhile are absorbed by this one.
    await job.moveToDelayed(Date.now() + SYNC_REQUEUE_DELAY_MS, token);
    throw new DelayedError();
  }
  return counts;
}

export const handlers: HandlerMap = {
  'hub.sync': createHubSyncHandler(),
};

import { and, eq, inArray } from 'drizzle-orm';
import type { Job } from 'bullmq';
import type { JobPayload } from '@voicespark/core/queues';
import { AppError } from '@voicespark/core/errors';
import * as imports from '@voicespark/core/services/imports';
import { connectedSource, getDb, importJob, withTransaction } from '@voicespark/db';
import type { HandlerMap } from '../handlers';

export type SyncPollOutcome =
  'not_connected' | 'job_in_progress' | 'range_complete' | 'incremental' | 'resync';

type SyncPollJob = Job<JobPayload<'sync.poll'>, unknown, 'sync.poll'>;

/** Today as `YYYY-MM-DD` (UTC), comparable with `date` columns (mode 'string'). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `sync.poll` (jobs contract 2, FR-012): one scheduled tick per source. Creates an `incremental` import job, or a
 * `resync` one when a completed folder has lost its cursor (expired), and enqueues the first page.
 */
async function syncPoll(
  job: SyncPollJob,
): Promise<{ outcome: SyncPollOutcome; importJobId?: string }> {
  const { userId, sourceId } = job.data;
  const db = getDb();
  const [source] = await db
    .select({ status: connectedSource.status, dateRangeTo: connectedSource.dateRangeTo })
    .from(connectedSource)
    .where(and(eq(connectedSource.id, sourceId), eq(connectedSource.userId, userId)))
    .limit(1);
  if (!source || source.status !== 'connected') return { outcome: 'not_connected' };

  const [active] = await db
    .select({ id: importJob.id })
    .from(importJob)
    .where(
      and(
        eq(importJob.sourceId, sourceId),
        inArray(importJob.status, imports.NON_TERMINAL_STATUSES),
      ),
    )
    .limit(1);
  if (active) return { outcome: 'job_in_progress' };

  // A closed date range in the past has nothing new to fetch (R25).
  if (source.dateRangeTo !== null && source.dateRangeTo < today())
    return { outcome: 'range_complete' };

  let created: { id: string; kind: 'incremental' | 'resync' };
  try {
    created = await withTransaction(async (tx) => {
      const expired = (await imports.loadCursors(sourceId, tx)).filter(
        (f) => f.initialComplete && f.cursor === null,
      );
      const kind = expired.length > 0 ? 'resync' : 'incremental';
      const { id } = await imports.createJob({ userId, sourceId, kind }, tx);
      // The resync job's creator resets the affected folders so import.page re-runs their initial walk.
      for (const f of expired) {
        await imports.checkpoint(
          sourceId,
          f.folderKey,
          { initialCheckpoint: null, cursor: null, initialComplete: false },
          tx,
        );
      }
      return { id, kind };
    });
  } catch (err) {
    // A job created concurrently (resume, reconnect) wins; the next tick re-evaluates.
    if (err instanceof AppError && err.code === 'conflict') return { outcome: 'job_in_progress' };
    throw err;
  }

  await imports.enqueuePage({ userId, sourceId, importJobId: created.id });
  return { outcome: created.kind, importJobId: created.id };
}

export const handlers: HandlerMap = {
  'sync.poll': syncPoll,
};

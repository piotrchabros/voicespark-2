import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { loadEnv } from '@voicespark/core/env';
import { jobLogger } from '@voicespark/core/logger';
import { enqueue, jobIds, type JobPayload } from '@voicespark/core/queues';
import {
  DeletionError,
  SOURCE_WAIT_DELAY_MS,
  VERIFY_SWEEP_DELAY_MS,
  executeDeletion,
  getDeletion,
  recordDeletionFailure,
} from '@voicespark/core/services/deletion';
import * as profiles from '@voicespark/core/services/profiles';
import { createMailer, type Mailer } from '@voicespark/integrations/smtp';
import { createMemoryStore, type MemoryStore } from '@voicespark/integrations/supermemory';
import type { Handler, HandlerMap } from '../handlers';

/** Collaborators of the deletion processor; tests override them (InMemory store, recording mailer, revoke spy). */
export interface DeletionHandlerOverrides {
  store?: MemoryStore;
  mailer?: Mailer;
  /** Default (left undefined): core's `revokeGoogleToken`. */
  revokeGoogleToken?: (token: string) => Promise<void>;
}

type DeletionJob = Job<JobPayload<'deletion.execute'>, unknown, 'deletion.execute'>;

/** T121 (FR-035): profiles built from the purged source become outdated. Best effort: the purge is complete. */
async function afterSourcePurge(job: DeletionJob, deletionRequestId: string): Promise<void> {
  try {
    const request = await getDeletion(deletionRequestId);
    if (request?.userId) await profiles.recomputeOutdated(request.userId);
  } catch {
    jobLogger(job.id ?? deletionRequestId, { deletionRequestId }).warn({
      errorCode: 'profile_hook_failed',
    });
  }
}

/**
 * `deletion.execute` (jobs contract 6, R19). Job id `deletion-{id}`; the late-write sweep runs as `deletion-{id}-verify`.
 * Defaults are built lazily (on first job), never at module top level.
 */
export function createDeletionHandler(
  overrides: DeletionHandlerOverrides = {},
): Handler<'deletion.execute'> {
  let store: MemoryStore | undefined;
  let mailer: Mailer | undefined;

  return async (job: DeletionJob, token?: string): Promise<unknown> => {
    const { deletionRequestId, waitCount = 0 } = job.data;
    try {
      store ??= overrides.store ?? createMemoryStore(loadEnv());
      mailer ??= overrides.mailer ?? createMailer(loadEnv());
      const deps = {
        mailer,
        ...(overrides.revokeGoogleToken ? { revokeGoogleToken: overrides.revokeGoogleToken } : {}),
      };
      const result = await executeDeletion(deletionRequestId, store, { waitCount, deps });

      if (result.outcome === 'wait_import') {
        // Source or account: same job id, re-delayed 30 s; DelayedError does not consume an attempt.
        await job.updateData({ ...job.data, waitCount: waitCount + 1 });
        await job.moveToDelayed(Date.now() + SOURCE_WAIT_DELAY_MS, token);
        throw new DelayedError();
      }

      if (result.outcome === 'completed' && result.scope === 'source') {
        await afterSourcePurge(job, deletionRequestId);
      }

      const verifyJobId = jobIds.deletionVerify(deletionRequestId);
      const scheduleSweep =
        (result.outcome === 'completed' && result.scope === 'source') ||
        (result.outcome === 'swept' && job.id !== verifyJobId);
      if (scheduleSweep) {
        await enqueue(
          'deletion.execute',
          { deletionRequestId },
          { jobId: verifyJobId, delay: VERIFY_SWEEP_DELAY_MS },
        );
      }
      return {
        outcome: result.outcome,
        deletedCount: 'deletedCount' in result ? result.deletedCount : 0,
      };
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      const code = err instanceof DeletionError ? err.code : 'deletion_error';
      const retryable = !(err instanceof DeletionError) || err.retryable;
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await recordDeletionFailure(deletionRequestId, code, !retryable || finalAttempt);
      if (!retryable) throw new UnrecoverableError(code);
      throw err instanceof DeletionError ? err : new Error(code);
    }
  };
}

export const handlers: HandlerMap = {
  'deletion.execute': createDeletionHandler(),
};

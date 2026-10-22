import { UnrecoverableError, type Job } from 'bullmq';
import type { JobName, JobPayload } from '@voicespark/core/queues';

export type Handler<N extends JobName> = (
  job: Job<JobPayload<N>, unknown, N>,
  token?: string,
) => Promise<unknown>;

export type HandlerMap = { [N in JobName]?: Handler<N> };

/** Stub body for processors a later story implements; never retried. */
export function notImplemented(): never {
  throw new UnrecoverableError('not_implemented');
}

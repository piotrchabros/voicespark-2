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

/**
 * In-process per-job-name limits for a queue whose single BullMQ `Worker` runs several job types (one Worker per
 * queue cannot express per-job concurrency). A job over its name's limit waits here, still active and locked.
 * Names without a limit run unthrottled.
 */
export function perJobNameSemaphore(
  limits: Readonly<Record<string, number>>,
): <T>(name: string, run: () => Promise<T>) => Promise<T> {
  const active = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();

  const acquire = async (name: string, limit: number): Promise<void> => {
    if ((active.get(name) ?? 0) < limit) {
      active.set(name, (active.get(name) ?? 0) + 1);
      return;
    }
    // The releasing job hands its slot over, so the count stays as is.
    await new Promise<void>((resolve) => {
      const queue = waiting.get(name) ?? [];
      queue.push(resolve);
      waiting.set(name, queue);
    });
  };

  const release = (name: string): void => {
    const next = waiting.get(name)?.shift();
    if (next) next();
    else active.set(name, (active.get(name) ?? 1) - 1);
  };

  return async (name, run) => {
    const limit = limits[name];
    if (limit === undefined) return run();
    await acquire(name, limit);
    try {
      return await run();
    } finally {
      release(name);
    }
  };
}

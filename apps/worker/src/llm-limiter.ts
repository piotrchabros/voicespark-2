import { loadEnv } from '@voicespark/core/env';

// Process-local limit on concurrent LLM calls inside `hub.thread` (contracts/jobs.md: "LLM calls inside `hub.thread`
// also respect `WORKER_CONCURRENCY_LLM` through a process-local limiter"). The `hub` Worker runs four thread jobs at
// once; their triage and extraction calls share these slots. A call over the limit waits here, its job still active.

export type Limiter = <T>(run: () => Promise<T>) => Promise<T>;

/** A FIFO semaphore with `size` slots. */
export function createLimiter(size: number): Limiter {
  const limit = Math.max(1, Math.floor(size));
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active++;
      return;
    }
    // The releasing call hands its slot over, so the count stays as is.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return async (run) => {
    await acquire();
    try {
      return await run();
    } finally {
      release();
    }
  };
}

let shared: Limiter | undefined;

/** Runs `run` in one of the process's `WORKER_CONCURRENCY_LLM` slots (created on first use). */
export function withLlmSlot<T>(run: () => Promise<T>): Promise<T> {
  shared ??= createLimiter(loadEnv().WORKER_CONCURRENCY_LLM);
  return shared(run);
}

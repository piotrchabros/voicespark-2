import { UnrecoverableError } from 'bullmq';
import { toErrorCode } from '@voicespark/core/error-code';

export { toErrorCode };

// Constitution VI: logs and job.failedReason must never carry content or excluded values. Driver
// errors (drizzle/pg) put the SQL and its parameters in `message`, so only codes leave the worker.
// The code mapping itself lives in @voicespark/core/error-code (shared with the CLI).

/** BullMQ control-flow signals: must reach BullMQ as the original instance. */
const BULLMQ_SIGNALS = new Set([
  'DelayedError',
  'WaitingChildrenError',
  'WaitingError',
  'RateLimitError',
]);

/**
 * The error to rethrow to BullMQ (stored as failedReason/stacktrace). Errors whose message is
 * already a safe code pass through; others are replaced by one carrying only the code, keeping
 * UnrecoverableError (no retry) semantics. BullMQ signals such as DelayedError pass untouched.
 */
export function toSafeError(err: unknown): unknown {
  if (err instanceof Error && BULLMQ_SIGNALS.has(err.name)) return err;
  const code = toErrorCode(err);
  if (err instanceof Error && err.message === code) return err;
  return err instanceof Error && err.name === 'UnrecoverableError'
    ? new UnrecoverableError(code)
    : new Error(code);
}

// Constitution VI: logs, job.failedReason and CLI output must never carry content or excluded
// values. Driver errors (drizzle/pg) put the SQL and its parameters in `message`, so only codes
// leave the process.

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const PG_SQLSTATE = /^[0-9A-Z]{5}$/;

/** Error classes whose name is a stable, content-free identifier. */
const KNOWN_ERROR_NAMES = new Set([
  'AppError',
  'DeletionError',
  'DelayedError',
  'WaitingChildrenError',
  'WaitingError',
  'RateLimitError',
  'MailAuthError',
  'RateLimitedError',
  'HistoryExpiredError',
  'UidValidityChangedError',
  'ImapConnectError',
  'LlmRefusedError',
  'LlmConfigError',
  'MemoryStoreAuthError',
  'MemoryStoreBusyError',
  'MemoryStoreHttpError',
  'ClassifierError',
  'ZodError',
]);

function safeString(v: unknown): string | undefined {
  return typeof v === 'string' && SAFE_CODE.test(v) ? v : undefined;
}

function pgCode(err: Error): string | undefined {
  for (const c of [err, (err as { cause?: unknown }).cause]) {
    const code = (c as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && PG_SQLSTATE.test(code)) return `pg_${code}`;
  }
  return undefined;
}

/** A log- and Redis-safe code for any thrown value; never echoes the raw message. */
export function toErrorCode(err: unknown): string {
  if (!(err instanceof Error)) return 'internal_error';
  const code = (err as { code?: unknown }).code;
  if (err.name === 'AppError' || err.name === 'DeletionError') {
    return safeString(code) ?? 'internal_error';
  }
  const fromMessage = safeString(err.message);
  if (fromMessage) return fromMessage;
  if (KNOWN_ERROR_NAMES.has(err.name)) return safeString(code) ?? err.name;
  return pgCode(err) ?? 'internal_error';
}

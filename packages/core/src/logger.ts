import pino, { type Logger } from 'pino';

/**
 * The only shapes the logger accepts: ids, counts, error codes and enum literals.
 * No index signature and no content keys, so passing an InspectionInput or a
 * message body fails to compile (research R8; FR-020).
 */
export interface SafeLogFields {
  jobId?: string;
  jobName?: string;
  queue?: string;
  userId?: string;
  sourceId?: string;
  importJobId?: string;
  uploadId?: string;
  deletionRequestId?: string;
  notificationId?: string;
  requestId?: string;
  entityId?: string;
  errorCode?: string;
  status?: string;
  scope?: string;
  attempt?: number;
  count?: number;
  counts?: Record<string, number>;
  durationMs?: number;
}

type LogMethod = (fields: SafeLogFields, msg?: string) => void;

export interface SafeLogger {
  trace: LogMethod;
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  child(bindings: SafeLogFields): SafeLogger;
}

/**
 * Defence in depth: content and secret keys pino must never print, even if a caller smuggles them past the types.
 * fast-redact has no partial-key wildcards (`*_enc` never matches), so every key is listed explicitly, in camelCase
 * and snake_case, at top level and one and two levels deep. `scrubSecrets` (formatters.log) catches anything else
 * whose key matches SECRET_KEY_PATTERN, at any depth.
 */
const REDACT_KEYS: readonly string[] = [
  // plaintext content
  'bodyText',
  'body_text',
  'subject',
  'headers',
  // encrypted columns (packages/db/src/schema: every *Enc / *_enc column)
  'bodyEnc',
  'body_enc',
  'briefEnc',
  'brief_enc',
  'feedbackEnc',
  'feedback_enc',
  'notesEnc',
  'notes_enc',
  'topicEnc',
  'topic_enc',
  'titleEnc',
  'title_enc',
  'textEnc',
  'text_enc',
  'generatedTextEnc',
  'generated_text_enc',
  'editedTextEnc',
  'edited_text_enc',
  'notifyEmailEnc',
  'notify_email_enc',
  'emailEnc',
  'email_enc',
  'imapPasswordEnc',
  'imap_password_enc',
  'passwordEnc',
  'password_enc',
  'accessTokenEnc',
  'access_token_enc',
  'refreshTokenEnc',
  'refresh_token_enc',
  'tokenEnc',
  'token_enc',
  'codeVerifierEnc',
  'code_verifier_enc',
  'verifierEnc',
  'verifier_enc',
  // secrets
  'password',
  'imapPassword',
  'imap_password',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'token',
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'codeVerifier',
  'code_verifier',
];

export const REDACT_PATHS: readonly string[] = REDACT_KEYS.flatMap((k) => [
  k,
  `*.${k}`,
  `*.*.${k}`,
]);

/** Key suffixes that always mark content or a secret; matched case-insensitively at any depth. */
export const SECRET_KEY_PATTERN =
  /(_enc|enc|token|password|secret|cookie|authorization|apikey|api_key|headers|bodytext|subject)$/i;

const CENSOR = '[redacted]';

/** Recursively replaces the value of every key matching SECRET_KEY_PATTERN with the censor string. */
export function scrubSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, seen));
  if (value instanceof Error) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? CENSOR : scrubSecrets(v, seen);
  }
  return out;
}

function wrap(base: Logger): SafeLogger {
  const method =
    (level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'): LogMethod =>
    (fields, msg) => {
      base[level](fields, msg);
    };
  return {
    trace: method('trace'),
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    fatal: method('fatal'),
    child: (bindings) => wrap(base.child(scrubSecrets(bindings) as SafeLogFields)),
  };
}

export function createLogger(
  opts: { level?: string; base?: SafeLogFields; destination?: pino.DestinationStream } = {},
): SafeLogger {
  const instance = pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      redact: { paths: [...REDACT_PATHS], censor: CENSOR },
      formatters: {
        log: (obj) => scrubSecrets(obj) as Record<string, unknown>,
      },
      ...(opts.base ? { base: opts.base } : {}),
    },
    opts.destination,
  );
  return wrap(instance);
}

let root: SafeLogger | undefined;
const getRoot = (): SafeLogger => (root ??= createLogger());

/** Lazy: the underlying pino instance is created on first use, not at import. */
export const logger: SafeLogger = {
  trace: (f, m) => getRoot().trace(f, m),
  debug: (f, m) => getRoot().debug(f, m),
  info: (f, m) => getRoot().info(f, m),
  warn: (f, m) => getRoot().warn(f, m),
  error: (f, m) => getRoot().error(f, m),
  fatal: (f, m) => getRoot().fatal(f, m),
  child: (b) => getRoot().child(b),
};

/** Child logger that carries only the job id (plus optional safe fields). */
export function jobLogger(jobId: string, extra: SafeLogFields = {}): SafeLogger {
  return logger.child({ ...extra, jobId });
}

import { z } from 'zod';

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

const optionalString = z.string().default('');

/** Placeholder sender for development; production must set its own MAIL_FROM. */
export const DEFAULT_MAIL_FROM = 'VoiceSpark <noreply@example.com>';
const int = (def: number) => z.coerce.number().int().positive().default(def);

const booleanFlag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const keyringSchema = z
  .string()
  .transform((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON object {kid: base64}' });
      return z.NEVER;
    }
    const result = z.record(z.string().min(1), z.string()).safeParse(parsed);
    if (!result.success || Object.keys(result.data).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a non-empty JSON object {kid: base64}' });
      return z.NEVER;
    }
    for (const [kid, value] of Object.entries(result.data)) {
      if (Buffer.from(value, 'base64').length !== 32) {
        ctx.addIssue({ code: 'custom', message: `key "${kid}" must be base64 of 32 bytes` });
        return z.NEVER;
      }
    }
    return result.data;
  });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1).default('postgres://voicespark:voicespark@localhost:5432/voicespark'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url().optional(),
    GOOGLE_SIGNIN_CLIENT_ID: optionalString,
    GOOGLE_SIGNIN_CLIENT_SECRET: optionalString,
    APPLE_CLIENT_ID: optionalString,
    APPLE_TEAM_ID: optionalString,
    APPLE_KEY_ID: optionalString,
    APPLE_PRIVATE_KEY: optionalString,
    MICROSOFT_SIGNIN_CLIENT_ID: optionalString,
    MICROSOFT_SIGNIN_CLIENT_SECRET: optionalString,
    MICROSOFT_SIGNIN_TENANT_ID: z.string().min(1).default('common'),
    FACEBOOK_CLIENT_ID: optionalString,
    FACEBOOK_CLIENT_SECRET: optionalString,
    GOOGLE_MAIL_CLIENT_ID: optionalString,
    GOOGLE_MAIL_CLIENT_SECRET: optionalString,
    MICROSOFT_MAIL_CLIENT_ID: optionalString,
    MICROSOFT_MAIL_CLIENT_SECRET: optionalString,
    MICROSOFT_MAIL_TENANT_ID: z.string().min(1).default('common'),
    ENCRYPTION_KEYRING: keyringSchema,
    ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
    DEDUP_HMAC_KEY: z.string().min(1),
    SUPERMEMORY_API_KEY: optionalString,
    SUPERMEMORY_BASE_URL: z.string().url().default('https://supermemory.voicespark.ai'),
    // v3 = self-hosted REST server; v5 = hosted api.supermemory.ai.
    SUPERMEMORY_API_VERSION: z.enum(['v5', 'v3']).default('v3'),
    ANTHROPIC_API_KEY: optionalString,
    LLM_PROFILE_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
    LLM_DRAFT_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
    LLM_CLASSIFIER_MODEL: z.string().min(1).default('claude-haiku-5-5'),
    LLM_ALLOWED_MODELS: z
      .string()
      .default('claude-sonnet-5-5,claude-opus-5-5')
      .transform((v) =>
        v
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m.length > 0),
      ),
    SMTP_URL: optionalString,
    MAIL_FROM: z.string().min(1).default(DEFAULT_MAIL_FROM),
    UPLOAD_TMP_DIR: z.string().min(1).default('/data/uploads-tmp'),
    UPLOAD_MAX_BYTES: int(10485760),
    WORKER_CONCURRENCY_IMPORT: int(8),
    WORKER_CONCURRENCY_LLM: int(4),
    SYNC_POLL_INTERVAL_MINUTES: int(5),
    AUTH_TEST_MODE: booleanFlag,
    // Test-only switches (e2e): the shared memory-store bridge and GreenMail's self-signed IMAP certificate.
    // Both are honoured only under NODE_ENV=test / AUTH_TEST_MODE and refused in production.
    TEST_MEMORY_STORE_URL: z.string().url().optional(),
    TEST_IMAP_INSECURE_TLS: booleanFlag,
  })
  .superRefine((env, ctx) => {
    if (!(env.ENCRYPTION_ACTIVE_KEY_ID in env.ENCRYPTION_KEYRING)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_ACTIVE_KEY_ID'],
        message: 'must be a key id present in ENCRYPTION_KEYRING',
      });
    }
    if (
      env.SUPERMEMORY_API_VERSION === 'v5' &&
      new URL(env.SUPERMEMORY_BASE_URL).hostname === 'supermemory.voicespark.ai'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPERMEMORY_API_VERSION'],
        message: 'v5 cannot be used with the self-hosted supermemory.voicespark.ai (it speaks v3)',
      });
    }
  })
  .transform((env) => ({ ...env, BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? env.APP_URL }));

export type Env = z.infer<typeof envSchema>;

/**
 * Refuses to start in production with the test auth bypass, any test-only switch, without the external service
 * keys (research R24), or without SMTP (an unset SMTP_URL would otherwise drop every email silently).
 */
export function assertProductionSafety(env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (env.AUTH_TEST_MODE) problems.push('AUTH_TEST_MODE must be unset in production');
  if (env.TEST_MEMORY_STORE_URL) problems.push('TEST_MEMORY_STORE_URL must be unset in production');
  if (env.TEST_IMAP_INSECURE_TLS) problems.push('TEST_IMAP_INSECURE_TLS must be unset in production');
  if (!env.SUPERMEMORY_API_KEY) problems.push('SUPERMEMORY_API_KEY is required in production');
  if (!env.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY is required in production');
  if (!env.SMTP_URL) problems.push('SMTP_URL is required in production');
  if (env.MAIL_FROM === DEFAULT_MAIL_FROM) problems.push('MAIL_FROM is required in production');
  if (problems.length > 0) throw new EnvError(`Unsafe production configuration: ${problems.join('; ')}`);
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  // Blank values (e.g. `KEY=` in .env) are treated as unset so defaults apply.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvError(`Invalid environment: ${issues.join('; ')}`);
  }
  assertProductionSafety(result.data);
  return result.data;
}

let cached: Env | undefined;

export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}

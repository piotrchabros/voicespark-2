import { beforeEach, describe, expect, it } from 'vitest';
import { EnvError, loadEnv, parseEnv, resetEnvForTests } from '../src/env';

const key = Buffer.alloc(32, 7).toString('base64');
const base = {
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEYRING: JSON.stringify({ k1: key }),
  ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  DEDUP_HMAC_KEY: key,
};

describe('parseEnv', () => {
  beforeEach(() => resetEnvForTests());

  it('applies defaults', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.BETTER_AUTH_URL).toBe('http://localhost:3000');
    expect(env.LLM_ALLOWED_MODELS).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(env.UPLOAD_MAX_BYTES).toBe(10485760);
    expect(env.WORKER_CONCURRENCY_IMPORT).toBe(8);
    expect(env.WORKER_CONCURRENCY_LLM).toBe(4);
    expect(env.SYNC_POLL_INTERVAL_MINUTES).toBe(5);
    expect(env.HUB_FILES_DIR).toBe('/data/hub-files');
    expect(env.HUB_FILE_MAX_BYTES).toBe(26214400);
    expect(env.LLM_HUB_EXTRACTION_MODEL).toBe('claude-sonnet-5-5');
    expect(env.LLM_HUB_EXTRACTION_EFFORT).toBe('medium');
    expect(env.AUTH_TEST_MODE).toBe(false);
    expect(env.ENCRYPTION_KEYRING).toEqual({ k1: key });
    expect(env.SUPERMEMORY_API_VERSION).toBe('v3');
    expect(env.SUPERMEMORY_BASE_URL).toBe('https://supermemory.voicespark.ai');
  });

  it('defaults the hub extraction model to the profile model and validates the effort', () => {
    expect(parseEnv({ ...base, LLM_PROFILE_MODEL: 'm-profile' }).LLM_HUB_EXTRACTION_MODEL).toBe(
      'm-profile',
    );
    expect(
      parseEnv({ ...base, LLM_PROFILE_MODEL: 'm-profile', LLM_HUB_EXTRACTION_MODEL: 'm-hub' })
        .LLM_HUB_EXTRACTION_MODEL,
    ).toBe('m-hub');
    expect(parseEnv({ ...base, LLM_HUB_EXTRACTION_EFFORT: 'high' }).LLM_HUB_EXTRACTION_EFFORT).toBe(
      'high',
    );
    expect(() => parseEnv({ ...base, LLM_HUB_EXTRACTION_EFFORT: 'max' })).toThrow(EnvError);
  });

  it('refuses a sync poll interval above 10 minutes', () => {
    expect(parseEnv({ ...base, SYNC_POLL_INTERVAL_MINUTES: '10' }).SYNC_POLL_INTERVAL_MINUTES).toBe(
      10,
    );
    expect(() => parseEnv({ ...base, SYNC_POLL_INTERVAL_MINUTES: '11' })).toThrow(
      /SYNC_POLL_INTERVAL_MINUTES/,
    );
  });

  it('validates the Supermemory API version against the base URL', () => {
    expect(() => parseEnv({ ...base, SUPERMEMORY_API_VERSION: 'v4' })).toThrow(EnvError);
    expect(() => parseEnv({ ...base, SUPERMEMORY_API_VERSION: 'v5' })).toThrow(
      /SUPERMEMORY_API_VERSION/,
    );
    const v5 = parseEnv({
      ...base,
      SUPERMEMORY_API_VERSION: 'v5',
      SUPERMEMORY_BASE_URL: 'https://api.supermemory.ai',
    });
    expect(v5.SUPERMEMORY_API_VERSION).toBe('v5');
  });

  it('treats blank values as unset and parses flags and lists', () => {
    const env = parseEnv({
      ...base,
      APP_URL: '',
      AUTH_TEST_MODE: '1',
      LLM_ALLOWED_MODELS: ' a , b ,',
      BETTER_AUTH_URL: 'https://auth.example.com',
    });
    expect(env.APP_URL).toBe('http://localhost:3000');
    expect(env.AUTH_TEST_MODE).toBe(true);
    expect(env.LLM_ALLOWED_MODELS).toEqual(['a', 'b']);
    expect(env.BETTER_AUTH_URL).toBe('https://auth.example.com');
  });

  it('rejects missing required values and bad keyrings', () => {
    expect(() => parseEnv({})).toThrow(EnvError);
    expect(() => parseEnv({ ...base, ENCRYPTION_KEYRING: 'not json' })).toThrow(EnvError);
    expect(() =>
      parseEnv({ ...base, ENCRYPTION_KEYRING: JSON.stringify({ k1: 'c2hvcnQ=' }) }),
    ).toThrow(EnvError);
    expect(() => parseEnv({ ...base, ENCRYPTION_ACTIVE_KEY_ID: 'k2' })).toThrow(EnvError);
    expect(() => parseEnv({ ...base, BETTER_AUTH_SECRET: 'short' })).toThrow(EnvError);
  });

  it('refuses unsafe production configuration', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      SUPERMEMORY_API_KEY: 'sm',
      ANTHROPIC_API_KEY: 'an',
      SMTP_URL: 'smtp://mail.example.org:587',
      MAIL_FROM: 'VoiceSpark <noreply@voicespark.example.org>',
    };
    expect(parseEnv(prod).NODE_ENV).toBe('production');
    expect(() => parseEnv({ ...prod, AUTH_TEST_MODE: '1' })).toThrow(/AUTH_TEST_MODE/);
    expect(() => parseEnv({ ...prod, SUPERMEMORY_API_KEY: '' })).toThrow(/SUPERMEMORY_API_KEY/);
    expect(() => parseEnv({ ...prod, SUPERMEMORY_API_KEY: undefined })).toThrow(
      /SUPERMEMORY_API_KEY is required/,
    );
    expect(() => parseEnv({ ...prod, ANTHROPIC_API_KEY: undefined })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => parseEnv({ ...prod, SMTP_URL: '' })).toThrow(/SMTP_URL is required/);
    expect(() => parseEnv({ ...prod, MAIL_FROM: undefined })).toThrow(/MAIL_FROM is required/);
  });

  it('refuses the e2e test plumbing in production and accepts it elsewhere', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      SUPERMEMORY_API_KEY: 'sm',
      ANTHROPIC_API_KEY: 'an',
      SMTP_URL: 'smtp://mail.example.org:587',
      MAIL_FROM: 'VoiceSpark <noreply@voicespark.example.org>',
    };
    expect(() => parseEnv({ ...prod, TEST_MEMORY_STORE_URL: 'http://127.0.0.1:4010' })).toThrow(
      /TEST_MEMORY_STORE_URL/,
    );
    expect(() => parseEnv({ ...prod, TEST_IMAP_INSECURE_TLS: '1' })).toThrow(
      /TEST_IMAP_INSECURE_TLS/,
    );
    const dev = parseEnv({
      ...base,
      TEST_MEMORY_STORE_URL: 'http://127.0.0.1:4010',
      TEST_IMAP_INSECURE_TLS: '1',
    });
    expect(dev.TEST_MEMORY_STORE_URL).toBe('http://127.0.0.1:4010');
    expect(dev.TEST_IMAP_INSECURE_TLS).toBe(true);
    const unset = parseEnv(base);
    expect(unset.TEST_MEMORY_STORE_URL).toBeUndefined();
    expect(unset.TEST_IMAP_INSECURE_TLS).toBe(false);
    expect(() => parseEnv({ ...base, TEST_MEMORY_STORE_URL: 'not a url' })).toThrow(EnvError);
  });

  it('allows test mode and missing keys outside production', () => {
    expect(parseEnv({ ...base, NODE_ENV: 'test', AUTH_TEST_MODE: 'true' }).AUTH_TEST_MODE).toBe(
      true,
    );
    expect(parseEnv({ ...base, NODE_ENV: 'development' }).SMTP_URL).toBe('');
  });
});

describe('loadEnv', () => {
  it('memoizes parseEnv(process.env)', () => {
    resetEnvForTests();
    Object.assign(process.env, base);
    const first = loadEnv();
    expect(loadEnv()).toBe(first);
    resetEnvForTests();
  });
});

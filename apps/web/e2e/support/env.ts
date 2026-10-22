import { tmpdir } from 'node:os';
import { join } from 'node:path';

// E2E environment (D-E1, D-E6): its own database on the postgres-test container, Redis db 3, the test-only memory
// bridge hosted by global setup, GreenMail for IMAP and SMTP. The ports are shared-host safe: the web port defaults
// to 3110 because 3100 is taken on this host (override with E2E_WEB_PORT); nothing here touches the dev stack.

export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3110);
export const E2E_MEMORY_PORT = Number(process.env.E2E_MEMORY_PORT ?? 4599);
export const E2E_DB_NAME = 'voicespark_e2e';
export const E2E_BASE_URL = `http://localhost:${E2E_WEB_PORT}`;

/** Admin connection used to create/drop the e2e database (the integration-suite DB on the same server). */
export const E2E_ADMIN_DATABASE_URL = 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';

export const E2E_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  AUTH_TEST_MODE: '1',
  LOG_LEVEL: 'info',
  APP_URL: E2E_BASE_URL,
  BETTER_AUTH_URL: E2E_BASE_URL,
  DATABASE_URL: `postgres://voicespark:voicespark@localhost:55432/${E2E_DB_NAME}`,
  REDIS_URL: 'redis://localhost:56379/3',
  TEST_MEMORY_STORE_URL: `http://127.0.0.1:${E2E_MEMORY_PORT}`,
  TEST_IMAP_INSECURE_TLS: '1',
  SMTP_URL: 'smtp://localhost:3025',
  MAIL_FROM: 'VoiceSpark <noreply@voicespark.test>',
  SYNC_POLL_INTERVAL_MINUTES: '1',
  UPLOAD_TMP_DIR: join(tmpdir(), 'vs-e2e-uploads'),
  WORKER_CONCURRENCY_LLM: '4',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-00',
  ENCRYPTION_KEYRING: JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') }),
  ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  DEDUP_HMAC_KEY: Buffer.alloc(32, 2).toString('base64'),
  // Blank = unset (parseEnv): real provider keys from the host shell must never reach the e2e stack.
  SUPERMEMORY_API_KEY: '',
  ANTHROPIC_API_KEY: '',
};

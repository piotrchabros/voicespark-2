import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_ENV, E2E_WEB_PORT } from './e2e/support/env';

// Propagates the e2e environment to global setup, fixtures and every CLI they spawn (e2e/README.md).
Object.assign(process.env, E2E_ENV);

const channel = process.env.PW_CHANNEL;

export default defineConfig({
  testDir: './e2e',
  // One shared database and global admin settings: run serially (D-E6).
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  globalSetup: './e2e/support/global-setup.ts',
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/e2e.json' }],
  ],
  // API-only fallback (no browser available): skip tests tagged @ui.
  ...(process.env.E2E_API_ONLY === '1' ? { grepInvert: /@ui/ } : {}),
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
    {
      name: 'mobile',
      testMatch: /us1-sign-in|us8-drafts/,
      grep: /@ui/,
      use: { ...devices['Pixel 7'], ...(channel ? { channel } : {}) },
    },
  ],
  // Only the web app; global setup owns the worker and the memory bridge.
  webServer: {
    command: `pnpm --filter @voicespark/web exec next dev -p ${E2E_WEB_PORT}`,
    url: `${E2E_BASE_URL}/sign-in`,
    env: E2E_ENV,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_ENV, E2E_WEB_PORT } from './e2e/support/env';

// Propagates the e2e environment to global setup, fixtures and every CLI they spawn (e2e/README.md).
Object.assign(process.env, E2E_ENV);

const channel = process.env.PW_CHANNEL;

// E2E_PROD=1: build and serve the app as a production server (`next build` + `next start`) instead of `next dev`, for
// the success-criterion timings (hub-sc-timings). NODE_ENV=test, not production: the production runtime and React
// build are used for anything other than 'development', while the env loader keeps refusing AUTH_TEST_MODE and the
// test memory bridge under 'production'. The build goes to `.next-e2e` (next.config.ts) so it never overwrites the
// `.next` that `next dev` and `next typegen` use. Default (unset): `next dev`, unchanged.
const E2E_PROD = process.env.E2E_PROD === '1';
const E2E_DIST_DIR = '.next-e2e';
const webServerEnv = E2E_PROD
  ? { ...E2E_ENV, NODE_ENV: 'test', VS_NEXT_DIST_DIR: E2E_DIST_DIR }
  : E2E_ENV;
const webServerCommand = E2E_PROD
  ? `pnpm --filter @voicespark/web exec next build && pnpm --filter @voicespark/web exec next start -p ${E2E_WEB_PORT}`
  : `pnpm --filter @voicespark/web exec next dev -p ${E2E_WEB_PORT}`;

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
    command: webServerCommand,
    url: `${E2E_BASE_URL}/sign-in`,
    env: webServerEnv,
    reuseExistingServer: false,
    // A production build on the loaded shared host takes minutes.
    timeout: E2E_PROD ? 900_000 : 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

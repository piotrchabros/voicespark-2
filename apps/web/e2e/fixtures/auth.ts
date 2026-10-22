import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test as base, type Page } from '@playwright/test';
import { userIdOf } from '../support/api';
import { E2E_BASE_URL, E2E_ENV } from '../support/env';

export type SignInProvider = 'google' | 'apple' | 'microsoft' | 'facebook';

export interface SignInOptions {
  /** Ignored when `relay` is set (a fresh private-relay address is used instead). */
  email: string;
  name?: string;
  role?: 'user' | 'admin';
  provider?: SignInProvider;
  /** Apple "Hide My Email": signs in with an @privaterelay.appleid.com address (provider defaults to apple). */
  relay?: boolean;
  /** Cancels at the mock provider (`cancel=1`): no session; the page ends on the error callback. */
  cancel?: boolean;
}

export interface SignInResult {
  userId: string;
  email: string;
}

/**
 * Signs in through the test-mode mock OAuth server, which AUTH_TEST_MODE registers under the four real provider ids.
 * Admin role is granted through the core CLI (against the e2e database), then the page reloads.
 */
export async function signInAs(page: Page, opts: SignInOptions & { cancel: true }): Promise<{ userId: null; email: string }>;
export async function signInAs(page: Page, opts: SignInOptions): Promise<SignInResult>;
export async function signInAs(
  page: Page,
  opts: SignInOptions,
): Promise<SignInResult | { userId: null; email: string }> {
  const email = opts.relay ? `${randomBytes(8).toString('hex')}@privaterelay.appleid.com` : opts.email;
  const name = opts.name ?? email.split('@')[0] ?? 'Test User';
  const provider = opts.provider ?? (opts.relay ? 'apple' : 'google');
  const res = await page.request.post('/api/auth/sign-in/social', {
    // Better Auth checks Origin whenever the request carries cookies (a second sign-in on the same page).
    headers: { origin: E2E_BASE_URL },
    data: {
      provider,
      callbackURL: '/dashboard',
      errorCallbackURL: `/oauth-error?provider=${provider}`,
      disableRedirect: true,
    },
  });
  if (!res.ok()) {
    throw new Error(`test-mode sign-in failed with status ${res.status()}`);
  }
  const { url } = (await res.json()) as { url: string };
  const params = new URLSearchParams({ login_hint: email, name });
  if (opts.cancel) params.set('cancel', '1');
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}${params.toString()}`);
  await page.waitForURL((u) => !u.pathname.startsWith('/api/auth'));
  if (opts.cancel) return { userId: null, email };

  if (opts.role === 'admin') {
    execFileSync('pnpm', ['--filter', '@voicespark/core', 'cli', 'admin:grant', '--email', email], {
      env: { ...process.env, ...E2E_ENV },
      stdio: 'ignore',
    });
    await page.reload();
  }
  return { userId: await userIdOf(page), email };
}

export interface SignInFixture {
  (opts: SignInOptions & { cancel: true }): Promise<{ userId: null; email: string }>;
  (opts: SignInOptions): Promise<SignInResult>;
}

export const test = base.extend<{ signInAs: SignInFixture }>({
  signInAs: async ({ page }, use) => {
    await use(((opts: SignInOptions) => signInAs(page, opts)) as SignInFixture);
  },
});

export { expect } from '@playwright/test';

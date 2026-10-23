import type { Page, TestInfo } from '@playwright/test';
import { LEGAL_LINKS } from '../lib/legal-links';
import { expect, test, type SignInProvider } from './fixtures/auth';
import { api, me } from './support/api';
import { E2E_BASE_URL } from './support/env';
import { setUserStatus } from './support/scripts';
import { measure } from './support/timing';

// US1 / SC-001 (quickstart section 6, T155): sign-in through the test-mode mock OAuth server that AUTH_TEST_MODE
// registers under the four real provider ids. API assertions are untagged; browser-only rows carry @ui.

const PROVIDERS: readonly SignInProvider[] = ['google', 'apple', 'microsoft', 'facebook'];
const LABELS: Record<SignInProvider, string> = {
  google: 'Google',
  apple: 'Apple',
  microsoft: 'Microsoft',
  facebook: 'Facebook',
};

interface Identity {
  id: string;
  provider: SignInProvider;
  providerEmail: string | null;
  emailVerified: boolean;
  isRelayEmail: boolean;
  linkedAt: string;
  linkedVia: 'signup' | 'confirmed_link' | 'manual_link';
}

const uniqueEmail = (info: TestInfo, tag: string) => `e2e-${tag}-${info.testId}-${Date.now()}@example.test`;

/** The mock authorize step needs the identity in the query (fixtures/auth.ts does the same). */
function withHint(url: string, email: string): string {
  const params = new URLSearchParams({ login_hint: email, name: email.split('@')[0] ?? 'Test User' });
  return `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
}

/** Routes the browser's own provider redirects (sign-in buttons, link buttons) through the mock with the hint. */
async function hintMockAuthorize(page: Page, email: string): Promise<void> {
  await page.route('**/api/test-oauth/authorize**', (route) =>
    route.continue({ url: withHint(route.request().url(), email) }),
  );
}

/**
 * Like the fixture's sign-in, but without expecting a session: returns where the browser ended up
 * (`/link-account`, `/sign-in?error=...`, `/dashboard`).
 */
async function startSocialSignIn(
  page: Page,
  provider: SignInProvider,
  email: string,
  callbackURL = '/dashboard',
): Promise<URL> {
  const res = await page.request.post('/api/auth/sign-in/social', {
    headers: { origin: E2E_BASE_URL },
    data: { provider, callbackURL, errorCallbackURL: `/oauth-error?provider=${provider}`, disableRedirect: true },
  });
  expect(res.ok(), `sign-in/social ${provider} -> ${res.status()}`).toBe(true);
  const { url } = (await res.json()) as { url: string };
  await page.goto(withHint(url, email));
  await page.waitForURL((u) => !u.pathname.startsWith('/api/') && u.pathname !== '/oauth-error');
  return new URL(page.url());
}

interface Hop {
  url: string;
  status: number;
  location: string | null;
}

/**
 * Walks the provider flow hop by hop (no browser navigation) so a refused sign-in can be asserted on the raw
 * callback response, not on wherever the browser happens to stop. Returns every hop, last one first.
 */
async function traceSocialSignIn(page: Page, provider: SignInProvider, email: string): Promise<Hop[]> {
  const res = await page.request.post('/api/auth/sign-in/social', {
    headers: { origin: E2E_BASE_URL },
    data: { provider, callbackURL: '/dashboard', errorCallbackURL: `/oauth-error?provider=${provider}`, disableRedirect: true },
  });
  expect(res.ok(), `sign-in/social ${provider} -> ${res.status()}`).toBe(true);
  let url = withHint(((await res.json()) as { url: string }).url, email);
  const hops: Hop[] = [];
  for (let i = 0; i < 10; i++) {
    const hop = await page.request.get(url, { maxRedirects: 0 });
    const location = hop.headers()['location'] ?? null;
    hops.unshift({ url, status: hop.status(), location });
    if (!location || hop.status() < 300 || hop.status() >= 400) break;
    url = new URL(location, url).toString();
  }
  return hops;
}

/** The page's own alert, not Next's route announcer (which also carries role=alert). */
const alertWith = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });

/** Drops the session cookie (page.request shares the context's cookies). */
const signOut = (page: Page) => page.context().clearCookies();

const identities = (page: Page) => api.get<Identity[]>(page, '/api/identities');

test('SC-001: sign-up with each provider under a minute; repeat sign-in reuses the account', async ({
  page,
  signInAs,
}, testInfo) => {
  for (const provider of PROVIDERS) {
    const email = uniqueEmail(testInfo, provider);
    const { first, again } = await measure(
      `sign-up and repeat sign-in (${provider})`,
      'SC-001',
      60_000,
      async () => {
        const first = await signInAs({ email, provider });
        await signOut(page);
        const again = await signInAs({ email, provider });
        return { first, again };
      },
    );
    expect(again.userId, provider).toBe(first.userId);
    expect((await me(page)).email).toBe(email);

    const list = await identities(page);
    expect(list.map((i) => i.provider), provider).toEqual([provider]);
    expect(list[0]).toMatchObject({ linkedVia: 'signup', isRelayEmail: false });
    // Facebook's email is never trusted as verified (R3); the others are.
    expect(list[0]?.emailVerified, provider).toBe(provider !== 'facebook');
    await signOut(page);
  }
});

test('same email on a second provider goes to /link-account and links only after confirmation', async ({
  page,
  signInAs,
}, testInfo) => {
  const email = uniqueEmail(testInfo, 'link');
  const { userId } = await signInAs({ email, provider: 'google' });
  await signOut(page);

  // Implicit linking is off: the second provider is parked on the link page without a session.
  const landed = await startSocialSignIn(page, 'microsoft', email);
  expect(landed.pathname).toBe('/link-account');
  expect(landed.searchParams.get('provider')).toBe('microsoft');
  await expect(me(page)).rejects.toMatchObject({ status: 401 });

  // Sign in with the existing provider first, coming back to the link page.
  const back = await startSocialSignIn(page, 'google', email, '/link-account?provider=microsoft');
  expect(back.pathname).toBe('/link-account');
  expect((await me(page)).id).toBe(userId);
  expect(await identities(page)).toHaveLength(1);

  // Explicit confirmation starts the provider flow for the pending provider only.
  const { redirectUrl } = await api.post<{ redirectUrl: string }>(page, '/api/identities/link', {
    provider: 'microsoft',
    via: 'confirmed_link',
  });
  await page.goto(withHint(redirectUrl, email));
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
  const done = new URL(page.url());
  expect(done.pathname).toBe('/dashboard');
  expect(done.searchParams.get('linked')).toBe('1');

  const list = await identities(page);
  expect(list.map((i) => i.provider).sort()).toEqual(['google', 'microsoft']);
  expect(list.find((i) => i.provider === 'microsoft')).toMatchObject({ linkedVia: 'confirmed_link', isRelayEmail: false });
  expect((await me(page)).id).toBe(userId);

  // The linked provider now signs straight into the same account.
  await signOut(page);
  expect((await signInAs({ email, provider: 'microsoft' })).userId).toBe(userId);
});

test('link-account page offers the confirmation for the pending provider @ui', async ({ page, signInAs }, testInfo) => {
  const email = uniqueEmail(testInfo, 'link-ui');
  const { userId } = await signInAs({ email, provider: 'google' });
  await signOut(page);
  await hintMockAuthorize(page, email);

  await startSocialSignIn(page, 'microsoft', email);
  await expect(page).toHaveURL(/\/link-account\?provider=microsoft$/);
  await expect(page.getByText('An account already exists')).toBeVisible();
  // Signed out: every provider except the pending one is offered for the first sign-in.
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/link-account\?provider=microsoft$/);
  await expect(page.getByText('Confirm to link Microsoft')).toBeVisible();
  // The click starts a multi-hop redirect chain (link POST -> authorize -> callback -> link/complete -> dashboard) that
  // can outlast the default 5s expect timeout on a busy dev server; wait for the navigation itself instead.
  await page.getByRole('button', { name: 'Link Microsoft' }).click();
  await page.waitForURL(/\/dashboard\?linked=1$/);

  expect((await me(page)).id).toBe(userId);
  expect((await identities(page)).map((i) => i.provider).sort()).toEqual(['google', 'microsoft']);
});

test('an Apple private-relay email gets no link offer', async ({ page, signInAs }, testInfo) => {
  const { userId: existing } = await signInAs({ email: uniqueEmail(testInfo, 'relay-existing'), provider: 'google' });
  await signOut(page);

  const relay = await signInAs({ email: '', relay: true });
  expect(relay.email.endsWith('@privaterelay.appleid.com')).toBe(true);
  expect(relay.userId).not.toBe(existing);
  // Straight into the app, never through /link-account.
  expect(new URL(page.url()).pathname).toBe('/dashboard');

  const list = await identities(page);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ provider: 'apple', isRelayEmail: true, linkedVia: 'signup' });
});

test('relay identity is shown without its address @ui', async ({ page, signInAs }) => {
  await signInAs({ email: '', relay: true });
  await page.goto('/settings/identities');
  await expect(page.getByText('Email hidden (relay)')).toBeVisible();
  await expect(page.getByText('privaterelay.appleid.com')).toHaveCount(0);
});

test('Google sign-in creates no Gmail source', async ({ page, signInAs }, testInfo) => {
  await signInAs({ email: uniqueEmail(testInfo, 'google-only'), provider: 'google' });
  expect(await api.get(page, '/api/sources')).toEqual([]);
  expect((await identities(page)).map((i) => i.provider)).toEqual(['google']);
});

test('cancelling at the provider redirects to /sign-in?error=oauth_cancelled', async ({ page, signInAs }, testInfo) => {
  const result = await signInAs({ email: uniqueEmail(testInfo, 'cancel'), cancel: true });
  expect(result.userId).toBeNull();
  const url = new URL(page.url());
  expect(url.pathname).toBe('/sign-in');
  expect(url.searchParams.get('error')).toBe('oauth_cancelled');
  await expect(me(page)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
});

test('sign-in page shows the providers and the cancel message @ui', async ({ page, signInAs }, testInfo) => {
  await signInAs({ email: uniqueEmail(testInfo, 'cancel-ui'), cancel: true });
  await expect(page).toHaveURL(/\/sign-in\?error=oauth_cancelled$/);
  await expect(alertWith(page, 'You cancelled')).toContainText('You cancelled at the provider; no account was created.');
  for (const provider of PROVIDERS) {
    await expect(page.getByRole('button', { name: `Continue with ${LABELS[provider]}` })).toBeVisible();
  }
  await expect(page.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', LEGAL_LINKS.terms);
  await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', LEGAL_LINKS.privacy);
});

test('a suspended account is refused with account_suspended', async ({ page, signInAs }, testInfo) => {
  const email = uniqueEmail(testInfo, 'suspended');
  await signInAs({ email });
  await setUserStatus(email, 'suspended');

  // The existing session no longer passes the guard.
  await expect(me(page)).rejects.toMatchObject({ status: 403, code: 'account_suspended' });
  await expect(api.get(page, '/api/sources')).rejects.toMatchObject({ status: 403, code: 'account_suspended' });

  // A fresh sign-in never gets a session (the session hook refuses it) and ends on the sign-in page.
  await signOut(page);
  const hops = await traceSocialSignIn(page, 'google', email);
  testInfo.annotations.push({
    type: 'suspended-sign-in',
    description: hops.map((h) => `${h.status} ${h.url}${h.location ? ` -> ${h.location}` : ''}`).join(' | '),
  });
  await expect(me(page)).rejects.toMatchObject({ status: 401 });
  const last = hops[0]!;
  expect(last.status, 'callback must redirect, not fail').toBeLessThan(400);
  const landed = new URL(last.location ?? last.url, E2E_BASE_URL);
  expect(landed.pathname).toBe('/sign-in');
  expect(landed.searchParams.get('error')).toBe('account_suspended');

  await setUserStatus(email, 'active');
});

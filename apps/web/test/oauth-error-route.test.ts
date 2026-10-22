import { describe, expect, it, vi } from 'vitest';

// Trailing slash on purpose: redirects must not double it.
vi.mock('@voicespark/core/env', () => ({ loadEnv: () => ({ APP_URL: 'https://app.example/' }) }));

import { GET } from '../app/(auth)/oauth-error/route';

// The container's listen origin differs from APP_URL behind a reverse proxy.
const call = (qs: string) => GET(new Request(`http://localhost:3000/oauth-error?${qs}`));

describe('GET /oauth-error', () => {
  it.each([
    ['provider=google&error=account_not_linked', '/link-account?provider=google'],
    ['provider=google&error=account_suspended', '/sign-in?error=account_suspended'],
    ['provider=google&error=access_denied', '/sign-in?error=oauth_cancelled'],
    ['provider=google&error=server_error', '/sign-in?error=oauth_failed'],
  ])('redirects %s to APP_URL%s, not the request origin', (qs, path) => {
    const res = call(qs);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://app.example${path}`);
  });
});

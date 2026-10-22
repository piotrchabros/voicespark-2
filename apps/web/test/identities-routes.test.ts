import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  linkSocial: vi.fn(),
  accountInfo: vi.fn(),
  listIdentities: vi.fn(),
  unlink: vi.fn(),
  completeLink: vi.fn(),
  accountRows: [] as unknown[],
  updateSet: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('../lib/auth', () => ({
  getAuth: () => ({ api: { linkSocialAccount: mocks.linkSocial, accountInfo: mocks.accountInfo } }),
  NULLED_PROVIDER_TOKENS: {
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  },
}));
vi.mock('../lib/guards', () => ({ requireUser: mocks.requireUser }));
vi.mock('@voicespark/core/env', () => ({ loadEnv: () => ({ APP_URL: 'http://app.test' }) }));
vi.mock('@voicespark/core/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@voicespark/core/queues', () => ({ getRedisConnection: vi.fn() }));
vi.mock('@voicespark/core/services/identities', async (orig) => ({
  ...(await orig<typeof import('@voicespark/core/services/identities')>()),
  listIdentities: mocks.listIdentities,
  unlink: mocks.unlink,
  completeLink: mocks.completeLink,
}));
vi.mock('@voicespark/db', async (orig) => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => mocks.accountRows,
    update: () => chain,
    set: (values: unknown) => {
      mocks.updateSet(values);
      return chain;
    },
  };
  return { ...(await orig<typeof import('@voicespark/db')>()), getDb: () => chain };
});

import { AppError } from '../lib/http';
import { GET as listGet } from '../app/api/identities/route';
import { POST as linkPost } from '../app/api/identities/link/route';
import { GET as completeGet } from '../app/api/identities/link/complete/route';
import { DELETE as unlinkDelete } from '../app/api/identities/[id]/route';

const ctx = { userId: 'u1', role: 'user' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(ctx);
  mocks.accountRows = [];
});

describe('GET /api/identities', () => {
  it('returns the list and 401s when unauthenticated', async () => {
    mocks.listIdentities.mockResolvedValue([{ id: 'a' }]);
    const res = await listGet(new Request('http://x/api/identities'), undefined);
    expect(await res.json()).toEqual([{ id: 'a' }]);
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    expect((await listGet(new Request('http://x/api/identities'), undefined)).status).toBe(401);
  });
});

describe('POST /api/identities/link', () => {
  const post = (body: unknown) =>
    linkPost(
      new Request('http://x/api/identities/link', { method: 'POST', body: JSON.stringify(body) }),
      undefined,
    );

  it('returns the provider redirect url', async () => {
    const authHeaders = new Headers();
    authHeaders.append('set-cookie', 'better-auth.state=abc; Path=/; HttpOnly');
    authHeaders.append('set-cookie', 'other=1; Path=/');
    mocks.linkSocial.mockResolvedValue({
      headers: authHeaders,
      response: { url: 'https://provider/auth', redirect: false },
    });
    const res = await post({ provider: 'google' });
    expect(await res.json()).toEqual({ redirectUrl: 'https://provider/auth' });
    expect(res.headers.getSetCookie()).toEqual([
      'better-auth.state=abc; Path=/; HttpOnly',
      'other=1; Path=/',
    ]);
    const arg = mocks.linkSocial.mock.calls[0]?.[0] as { body: Record<string, unknown> };
    expect(arg).toMatchObject({ returnHeaders: true });
    expect(arg.body).toMatchObject({ provider: 'google', disableRedirect: true });
    expect(arg.body.callbackURL).toBe(
      '/api/identities/link/complete?provider=google&via=manual_link',
    );
  });

  it('rejects an unknown provider', async () => {
    expect((await post({ provider: 'myspace' })).status).toBe(422);
  });
});

describe('GET /api/identities/link/complete', () => {
  const get = (qs: string) =>
    completeGet(new Request(`http://x/api/identities/link/complete?${qs}`), undefined);

  it('completes the link and redirects by via', async () => {
    mocks.accountRows = [{ id: 'acc1' }];
    mocks.accountInfo.mockResolvedValue({ user: { email: 'a@b.c', emailVerified: true } });
    const res = await get('provider=google&via=confirmed_link');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://app.test/dashboard?linked=1');
    expect(mocks.completeLink).toHaveBeenCalledWith(ctx, {
      provider: 'google',
      via: 'confirmed_link',
      providerEmail: 'a@b.c',
      emailVerified: true,
    });
    const manual = await get('provider=google');
    expect(manual.headers.get('location')).toBe('http://app.test/settings/identities?linked=1');
  });

  it('passes the Better Auth account row id to accountInfo', async () => {
    mocks.accountRows = [{ id: 'row-uuid-1' }];
    mocks.accountInfo.mockResolvedValue({ user: { email: 'a@b.c', emailVerified: false } });
    await get('provider=google');
    expect(mocks.accountInfo).toHaveBeenCalledWith(
      expect.objectContaining({ query: { accountId: 'row-uuid-1' } }),
    );
  });

  it('nulls the linked account provider tokens, also when accountInfo fails', async () => {
    mocks.accountRows = [{ id: 'acc1' }];
    mocks.accountInfo.mockRejectedValue(new Error('provider down'));
    const res = await get('provider=google');
    expect(res.headers.get('location')).toBe('http://app.test/settings/identities?linked=1');
    expect(mocks.updateSet).toHaveBeenCalledWith({
      accessToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
    expect(mocks.completeLink).toHaveBeenCalledWith(ctx, { provider: 'google', via: 'manual_link' });
  });

  it('redirects with link_failed when completion fails', async () => {
    mocks.completeLink.mockRejectedValue(new AppError('not_found'));
    const res = await get('provider=google');
    expect(res.headers.get('location')).toBe(
      'http://app.test/settings/identities?error=link_failed',
    );
  });
});

describe('DELETE /api/identities/[id]', () => {
  const del = () =>
    unlinkDelete(new Request('http://x'), { params: Promise.resolve({ id: 'acc1' }) });

  it('returns 204', async () => {
    expect((await del()).status).toBe(204);
    expect(mocks.unlink).toHaveBeenCalledWith(ctx, 'acc1');
  });

  it('maps last_identity', async () => {
    mocks.unlink.mockRejectedValue(new AppError('last_identity'));
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('last_identity');
  });
});

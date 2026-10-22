import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireFiltersConfirmed: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  startConnect: vi.fn(),
  completeConnect: vi.fn(),
  connectImap: vi.fn(),
}));

vi.mock('../lib/guards', () => ({
  requireUser: mocks.requireUser,
  requireFiltersConfirmed: mocks.requireFiltersConfirmed,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('../lib/http', async () => ({
  ...(await vi.importActual<object>('../lib/http')),
  rateLimit: mocks.rateLimit,
}));
// Trailing slash on purpose: redirects must not double it.
vi.mock('@voicespark/core/env', () => ({ loadEnv: () => ({ APP_URL: 'https://app.example/' }) }));
vi.mock('@voicespark/core/services/sources', () => ({
  list: mocks.list,
  get: mocks.get,
  startConnect: mocks.startConnect,
  completeConnect: mocks.completeConnect,
  connectImap: mocks.connectImap,
}));

import { AppError } from '@voicespark/core/errors';
import { GET as listSources } from '../app/api/sources/route';
import { GET as getSource } from '../app/api/sources/[id]/route';
import { POST as connect } from '../app/api/sources/connect/[provider]/route';
import { GET as callback } from '../app/api/sources/connect/[provider]/callback/route';
import { POST as connectImap } from '../app/api/sources/imap/route';

const user = { userId: 'u1', role: 'user' as const };
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const post = (body?: unknown) =>
  new Request('http://localhost/x', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/sources', () => {
  it('lists the caller sources', async () => {
    mocks.list.mockResolvedValue([{ id: 's1' }]);
    const res = await listSources(new Request('http://localhost/x'), undefined);
    expect(await res.json()).toEqual([{ id: 's1' }]);
    expect(mocks.list).toHaveBeenCalledWith(user);
  });
});

describe('GET /api/sources/{id}', () => {
  it('returns 404 and audits a foreign source', async () => {
    mocks.get.mockRejectedValue(new AppError('not_found'));
    const res = await getSource(new Request('http://localhost/x'), params({ id: 'abc' }));
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'source', 'abc');
  });
});

describe('POST /api/sources/connect/{provider}', () => {
  it('404s on an unknown provider', async () => {
    const res = await connect(post({}), params({ provider: 'yahoo' }));
    expect(res.status).toBe(404);
  });

  it('accepts an empty body', async () => {
    mocks.startConnect.mockResolvedValue({ authorizeUrl: 'https://a', consentSummary: {} });
    const res = await connect(post(), params({ provider: 'gmail' }));
    expect(res.status).toBe(200);
    expect(mocks.startConnect).toHaveBeenCalledWith(user, 'gmail', undefined);
  });

  it('passes the date range', async () => {
    mocks.startConnect.mockResolvedValue({ authorizeUrl: 'https://a', consentSummary: {} });
    await connect(post({ dateRange: { from: '2024-01-01' } }), params({ provider: 'microsoft' }));
    expect(mocks.startConnect).toHaveBeenCalledWith(user, 'microsoft', { from: '2024-01-01' });
  });

  it('is blocked until filters are confirmed', async () => {
    mocks.requireFiltersConfirmed.mockRejectedValue(new AppError('filter_confirmation_required'));
    const res = await connect(post({}), params({ provider: 'gmail' }));
    expect(res.status).toBe(409);
    expect(mocks.startConnect).not.toHaveBeenCalled();
  });
});

describe('GET /api/sources/connect/{provider}/callback', () => {
  const call = (qs: string, provider = 'gmail') =>
    // The container's listen origin differs from APP_URL behind a reverse proxy.
    callback(new Request(`http://localhost:3000/cb?${qs}`), params({ provider }));

  it('redirects to sign-in without a session', async () => {
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    const res = await call('code=c&state=s');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.example/sign-in');
  });

  it('maps access_denied to oauth_cancelled', async () => {
    const res = await call('error=access_denied');
    expect(res.headers.get('location')).toBe(
      'https://app.example/sources/connect?error=oauth_cancelled',
    );
  });

  it('maps other provider errors to oauth_failed', async () => {
    const res = await call('error=server_error');
    expect(res.headers.get('location')).toBe(
      'https://app.example/sources/connect?error=oauth_failed',
    );
  });

  it('redirects to the new source on success', async () => {
    mocks.completeConnect.mockResolvedValue({ sourceId: 'src1' });
    const res = await call('code=c&state=s');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.example/sources/src1');
    expect(mocks.completeConnect).toHaveBeenCalledWith(user, {
      state: 's',
      code: 'c',
      provider: 'gmail',
    });
  });

  it('redirects to oauth_failed on a service error', async () => {
    mocks.completeConnect.mockRejectedValue(new AppError('oauth_failed'));
    const res = await call('code=c&state=s');
    expect(res.headers.get('location')).toBe(
      'https://app.example/sources/connect?error=oauth_failed',
    );
  });
});

describe('POST /api/sources/imap', () => {
  const body = { host: 'imap.x', tlsMode: 'tls', username: 'me', password: 'pw' };

  it('returns 201 {source}, defaults the port and never echoes the password', async () => {
    mocks.connectImap.mockResolvedValue({ id: 's1' });
    const res = await connectImap(post(body), undefined);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('pw');
    expect(JSON.parse(text)).toEqual({ source: { id: 's1' } });
    expect(mocks.connectImap).toHaveBeenCalledWith(user, expect.objectContaining({ port: 993 }));
    expect(mocks.rateLimit).toHaveBeenCalledWith('imap-connect:u1', 10, 3600);
  });

  it('passes imap errors through', async () => {
    mocks.connectImap.mockRejectedValue(new AppError('imap_auth_failed'));
    const res = await connectImap(post(body), undefined);
    expect((await res.json()).error.code).toBe('imap_auth_failed');
  });

  it('rejects an invalid port', async () => {
    const res = await connectImap(post({ ...body, port: 70000 }), undefined);
    expect(res.status).toBe(422);
  });
});

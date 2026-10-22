import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as accountDeleteRoute from '../app/api/account/delete/route';
import * as deletionsIdRoute from '../app/api/deletions/[id]/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  requestAccountDeletion: vi.fn(),
  getForUser: vi.fn(),
}));

vi.mock('../lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@voicespark/core/services/deletion', () => ({
  requestAccountDeletion: mocks.requestAccountDeletion,
  getForUser: mocks.getForUser,
}));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };
const VALIDATION = 422;

const post = (body: unknown) =>
  new Request('http://localhost/api/account/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'better-auth.session_token=abc' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('POST /api/account/delete', () => {
  it('returns 202 with the request id and expires the session cookies', async () => {
    mocks.requestAccountDeletion.mockResolvedValue({ deletionRequestId: 'd1' });
    const { POST } = accountDeleteRoute;
    const res = await POST(post({ confirm: 'DELETE' }), undefined);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deletionRequestId: 'd1' });
    expect(mocks.requestAccountDeletion).toHaveBeenCalledWith(user);
    const cookies = res.headers.getSetCookie();
    const token = cookies.find((c) => c.includes('better-auth.session_token'));
    expect(token).toBeDefined();
    expect(token).toMatch(/Max-Age=0/i);
    expect(cookies.some((c) => c.includes('better-auth.session_data'))).toBe(true);
  });

  it.each([{}, { confirm: 'delete' }, { confirm: 'yes' }, { confirm: true }])(
    'rejects %j with 422 and does nothing',
    async (body) => {
      const { POST } = accountDeleteRoute;
      const res = await POST(post(body), undefined);
      expect(res.status).toBe(VALIDATION);
      expect(mocks.requestAccountDeletion).not.toHaveBeenCalled();
    },
  );

  it('maps last_admin to 409 without expiring cookies', async () => {
    mocks.requestAccountDeletion.mockRejectedValue(new AppError('last_admin'));
    const { POST } = accountDeleteRoute;
    const res = await POST(post({ confirm: 'DELETE' }), undefined);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('last_admin');
    expect(res.headers.getSetCookie().some((c) => /Max-Age=0/i.test(c))).toBe(false);
  });
});

describe('GET /api/deletions/[id]', () => {
  it('returns exactly the deletion view fields to the owner', async () => {
    const view = {
      id: ID,
      scope: 'account',
      status: 'pending',
      requestedAt: '2026-01-01T00:00:00.000Z',
      dueBy: '2026-01-02T00:00:00.000Z',
      completedAt: null,
    };
    mocks.getForUser.mockResolvedValue(view);
    const { GET } = deletionsIdRoute;
    const res = await GET(new Request('http://localhost/api/deletions/' + ID), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(mocks.getForUser).toHaveBeenCalledWith(user, ID);
  });

  it('audits a foreign access and returns 404 on not_found', async () => {
    mocks.getForUser.mockRejectedValue(new AppError('not_found'));
    const { GET } = deletionsIdRoute;
    const res = await GET(new Request('http://localhost/api/deletions/' + ID), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'deletion_request', ID);
  });
});

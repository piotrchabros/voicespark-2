import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as adminUsersRoute from '../app/api/admin/users/route';
import * as adminUsersIdRoute from '../app/api/admin/users/[id]/route';
import * as adminUsersIdSuspendRoute from '../app/api/admin/users/[id]/suspend/route';
import * as adminUsersIdReinstateRoute from '../app/api/admin/users/[id]/reinstate/route';
import * as adminUsersIdRoleRoute from '../app/api/admin/users/[id]/role/route';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  suspend: vi.fn(),
  reinstate: vi.fn(),
  setRole: vi.fn(),
}));

vi.mock('../lib/guards', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@voicespark/core/services/admin-users', () => ({
  list: mocks.list,
  detail: mocks.detail,
  suspend: mocks.suspend,
  reinstate: mocks.reinstate,
  setRole: mocks.setRole,
}));

const admin = { userId: '00000000-0000-4000-8000-000000000001', role: 'admin' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };
const summary = { id: ID, name: 'U', email: 'u@example.com', role: 'user', status: 'active' };
const created = new Date('2026-01-01T00:00:00.000Z');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue(admin);
});

describe('GET /api/admin/users', () => {
  it('passes filters and pagination and returns the page', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          ...summary,
          providers: ['google'],
          sourceCount: 2,
          createdAt: created,
          lastSignInAt: null,
        },
      ],
      nextCursor: null,
    });
    const { GET } = adminUsersRoute;
    const res = await GET(
      new Request('http://x/api/admin/users?query=bob&role=admin&status=active&limit=5&cursor=c'),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({
      limit: 5,
      cursor: 'c',
      query: 'bob',
      role: 'admin',
      status: 'active',
    });
    const json = await res.json();
    expect(json.items[0].createdAt).toBe(created.toISOString());
  });

  it('rejects an unknown role filter', async () => {
    const { GET } = adminUsersRoute;
    const res = await GET(new Request('http://x/api/admin/users?role=root'), undefined);
    expect(res.status).toBe(422);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admins', async () => {
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    const { GET } = adminUsersRoute;
    const res = await GET(new Request('http://x/api/admin/users'), undefined);
    expect(res.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('fails closed when the service returns a forbidden field', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          ...summary,
          providers: [],
          sourceCount: 0,
          createdAt: created,
          lastSignInAt: null,
          bodyText: 'leak',
        },
      ],
      nextCursor: null,
    });
    const { GET } = adminUsersRoute;
    const res = await GET(new Request('http://x/api/admin/users'), undefined);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('leak');
  });
});

describe('GET /api/admin/users/[id]', () => {
  it('returns the detail', async () => {
    mocks.detail.mockResolvedValue({
      ...summary,
      createdAt: created,
      lastSignInAt: null,
      suspendedAt: null,
      identities: [],
      sources: [],
      profiles: [],
    });
    const { GET } = adminUsersIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith(ID);
  });

  it('returns 404 for a missing or malformed id', async () => {
    mocks.detail.mockRejectedValue(new AppError('not_found'));
    const { GET } = adminUsersIdRoute;
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    const bad = { params: Promise.resolve({ id: 'nope' }) };
    expect((await GET(new Request('http://x'), bad)).status).toBe(404);
    expect(mocks.detail).toHaveBeenCalledTimes(1);
  });
});

describe('suspend / reinstate / role', () => {
  it('suspend accepts an empty body', async () => {
    mocks.suspend.mockResolvedValue({ ...summary, status: 'suspended' });
    const { POST } = adminUsersIdSuspendRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(200);
    expect(mocks.suspend).toHaveBeenCalledWith(admin.userId, ID, undefined);
    expect(await res.json()).toEqual({ user: { ...summary, status: 'suspended' } });
  });

  it('suspend passes the reason and validates its length', async () => {
    mocks.suspend.mockResolvedValue({ ...summary, status: 'suspended' });
    const { POST } = adminUsersIdSuspendRoute;
    const ok = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ reason: 'spam' }) }),
      params,
    );
    expect(ok.status).toBe(200);
    expect(mocks.suspend).toHaveBeenCalledWith(admin.userId, ID, 'spam');
    const tooLong = await POST(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({ reason: 'x'.repeat(501) }),
      }),
      params,
    );
    expect(tooLong.status).toBe(422);
  });

  it('suspend maps last_admin', async () => {
    mocks.suspend.mockRejectedValue(new AppError('last_admin'));
    const { POST } = adminUsersIdSuspendRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(new AppError('last_admin').status);
    expect((await res.json()).error.code).toBe('last_admin');
  });

  it('reinstate returns the user', async () => {
    mocks.reinstate.mockResolvedValue(summary);
    const { POST } = adminUsersIdReinstateRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(200);
    expect(mocks.reinstate).toHaveBeenCalledWith(admin.userId, ID);
    expect(await res.json()).toEqual({ user: summary });
  });

  it('role sets the role', async () => {
    mocks.setRole.mockResolvedValue({ ...summary, role: 'admin' });
    const { PUT } = adminUsersIdRoleRoute;
    const res = await PUT(
      new Request('http://x', { method: 'PUT', body: JSON.stringify({ role: 'admin' }) }),
      params,
    );
    expect(res.status).toBe(200);
    expect(mocks.setRole).toHaveBeenCalledWith(admin.userId, ID, 'admin');
  });

  it('role validates the body', async () => {
    const { PUT } = adminUsersIdRoleRoute;
    const res = await PUT(
      new Request('http://x', { method: 'PUT', body: JSON.stringify({ role: 'owner' }) }),
      params,
    );
    expect(res.status).toBe(422);
    expect(mocks.setRole).not.toHaveBeenCalled();
  });
});

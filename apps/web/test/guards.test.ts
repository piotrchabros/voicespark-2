import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  rows: [] as unknown[],
  record: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('../lib/auth', () => ({ getAuth: () => ({ api: { getSession: mocks.getSession } }) }));
vi.mock('@voicespark/core/services/audit', () => ({ audit: { record: mocks.record } }));
vi.mock('@voicespark/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => mocks.rows,
  };
  const table = (name: string) => ({ id: `${name}.id`, userId: `${name}.userId` });
  return {
    getDb: () => chain,
    user: { id: 'user.id', role: 'user.role', status: 'user.status' },
    connectedSource: table('source'),
    contentItem: table('content'),
    importJob: table('job'),
    notification: table('notification'),
    deletionRequest: table('deletion'),
    retroscan: table('retroscan'),
    exclusionRule: table('rule'),
    upload: table('upload'),
    toneProfile: table('profile'),
    profileGeneration: table('generation'),
    draft: table('draft'),
    signInIdentity: { accountId: 'identity.accountId', userId: 'identity.userId' },
    filterPreferences: { userId: 'fp.userId', confirmedAt: 'fp.confirmedAt' },
  };
});
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

import {
  auditForeignAccess,
  requireAdmin,
  requireFiltersConfirmed,
  requireUser,
  type UserContext,
} from '../lib/guards';

const ID = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const ADMIN: UserContext = { userId: 'a-1', role: 'admin' };

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.record.mockReset();
  mocks.rows = [];
});

describe('requireUser', () => {
  it('rejects a missing session with unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(requireUser()).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('rejects a suspended user even with a valid session', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-1' } });
    mocks.rows = [{ role: 'user', status: 'suspended' }];
    await expect(requireUser()).rejects.toMatchObject({ code: 'account_suspended', status: 403 });
  });

  it('returns the context using the database role', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-1', role: 'user' } });
    mocks.rows = [{ role: 'admin', status: 'active' }];
    await expect(requireUser()).resolves.toEqual({ userId: 'u-1', role: 'admin' });
  });
});

describe('requireAdmin', () => {
  it('rejects non-admins with admin_required', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'u-1' } });
    mocks.rows = [{ role: 'user', status: 'active' }];
    await expect(requireAdmin()).rejects.toMatchObject({ code: 'admin_required', status: 403 });
  });

  it('accepts admins', async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 'a-1' } });
    mocks.rows = [{ role: 'admin', status: 'active' }];
    await expect(requireAdmin()).resolves.toEqual(ADMIN);
  });
});

describe('auditForeignAccess', () => {
  it("audits when an admin targets another user's resource", async () => {
    mocks.rows = [{ id: ID, userId: 'u-9' }];
    await auditForeignAccess(ADMIN, 'content_item', ID);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'admin',
        actorUserId: 'a-1',
        action: 'admin.content_access_denied',
        metadata: { resourceType: 'content_item', targetId: ID },
      }),
    );
  });

  it('does not audit when the id does not exist', async () => {
    mocks.rows = [];
    await auditForeignAccess(ADMIN, 'source', ID);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('does not audit regular users', async () => {
    mocks.rows = [{ id: ID, userId: 'u-9' }];
    await auditForeignAccess({ userId: 'u-1', role: 'user' }, 'source', ID);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('ignores ids that are not uuids', async () => {
    mocks.rows = [{ id: ID, userId: 'u-9' }];
    await auditForeignAccess(ADMIN, 'source', 'nope');
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe('requireFiltersConfirmed', () => {
  it('throws 409 when unconfirmed or missing', async () => {
    mocks.rows = [{ confirmedAt: null }];
    await expect(requireFiltersConfirmed(ADMIN)).rejects.toMatchObject({
      code: 'filter_confirmation_required',
      status: 409,
    });
    mocks.rows = [];
    await expect(requireFiltersConfirmed(ADMIN)).rejects.toMatchObject({ status: 409 });
  });

  it('passes when confirmed', async () => {
    mocks.rows = [{ confirmedAt: new Date() }];
    await expect(requireFiltersConfirmed(ADMIN)).resolves.toBeUndefined();
  });
});

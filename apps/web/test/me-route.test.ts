import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  prefs: vi.fn(),
  rows: [] as unknown[],
}));

vi.mock('../lib/guards', () => ({ requireUser: mocks.requireUser }));
vi.mock('@voicespark/core/queues', () => ({ getRedisConnection: vi.fn() }));
vi.mock('@voicespark/core/services/filter-preferences', () => ({ get: mocks.prefs }));
vi.mock('@voicespark/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => mocks.rows,
  };
  const col = (n: string) => `user.${n}`;
  return {
    getDb: () => chain,
    user: {
      id: col('id'),
      name: col('name'),
      email: col('email'),
      role: col('role'),
      status: col('status'),
      createdAt: col('createdAt'),
    },
  };
});
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

import { GET } from '../app/api/me/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ userId: 'u1', role: 'user' });
  mocks.rows = [
    {
      id: 'u1',
      name: 'Ann',
      email: 'a@b.c',
      role: 'user',
      status: 'active',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];
});

describe('GET /api/me', () => {
  it('returns the profile with filtersConfirmed', async () => {
    mocks.prefs.mockResolvedValue({ confirmedAt: '2026-01-02T00:00:00.000Z' });
    const body = await (await GET(new Request('http://x/api/me'), undefined)).json();
    expect(body).toEqual({
      id: 'u1',
      name: 'Ann',
      email: 'a@b.c',
      role: 'user',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      filtersConfirmed: true,
    });
  });

  it('reports filtersConfirmed false and 401s without a session', async () => {
    mocks.prefs.mockResolvedValue({ confirmedAt: null });
    expect((await (await GET(new Request('http://x'), undefined)).json()).filtersConfirmed).toBe(
      false,
    );
    const { AppError } = await import('../lib/http');
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    expect((await GET(new Request('http://x'), undefined)).status).toBe(401);
  });
});

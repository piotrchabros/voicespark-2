import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as searchRoute from '../app/api/hub/search/route';

// Keyword search over the user's own hub (contracts/http-api.md "Search", contracts/hub-search.md; FR-011).

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/hub/search', () => ({ search: mocks.search }));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

const noParams = { params: Promise.resolve({}) };

function get(query: string): Promise<Response> {
  return searchRoute.GET(new Request(`http://x/api/hub/search${query}`), noParams);
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

const noteItem = {
  type: 'note',
  id: ID,
  title: 'Call with the grower',
  owner: { kind: 'person', id: OWNER, name: 'Anna Nowak' },
  snippets: [{ text: 'We discussed the thermostat budget for the spring beds.', highlights: [[17, 27]] }],
  updatedAt: '2026-03-01T10:00:00.000Z',
};

const personItem = {
  type: 'person',
  id: OWNER,
  title: 'Anna Nowak',
  owner: null,
  snippets: [{ text: 'Anna Nowak', highlights: [[0, 4]] }],
  updatedAt: '2026-02-01T10:00:00.000Z',
};

const empty = { items: [], nextCursor: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
  mocks.search.mockResolvedValue(empty);
});

describe('GET /api/hub/search', () => {
  it('returns {items, nextCursor} in the contract shape and passes q, types, limit and cursor to the service', async () => {
    mocks.search.mockResolvedValue({ items: [noteItem, personItem], nextCursor: 'next' });
    const res = await get('?q=thermostat%20anna&types=note,person&limit=10&cursor=abc');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [noteItem, personItem], nextCursor: 'next' });
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ['type', 'id', 'title', 'owner', 'snippets', 'updatedAt'].sort(),
    );
    expect(Object.keys(body.items[0].snippets[0]).sort()).toEqual(['text', 'highlights'].sort());
    expect(body.items[0].owner).toEqual({ kind: 'person', id: OWNER, name: 'Anna Nowak' });
    expect(body.items[1].owner).toBeNull();
    expect(mocks.search).toHaveBeenCalledWith(user, {
      q: 'thermostat anna',
      types: ['note', 'person'],
      limit: 10,
      cursor: 'abc',
    });
  });

  it('uses the default limit of 20 and no types or cursor when none are given', async () => {
    const res = await get('?q=anna');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(empty);
    expect(mocks.search).toHaveBeenCalledWith(user, { q: 'anna', limit: 20 });
  });

  it('caps the limit at 100', async () => {
    expect((await get('?q=anna&limit=100')).status).toBe(200);
    expect(mocks.search).toHaveBeenLastCalledWith(user, { q: 'anna', limit: 100 });
    expect((await get('?q=anna&limit=500')).status).toBe(200);
    expect(mocks.search).toHaveBeenLastCalledWith(user, { q: 'anna', limit: 100 });
  });

  it('accepts q of 1 and of 200 chars and rejects a missing, empty or 201-char q with 422', async () => {
    expect((await get('?q=a')).status).toBe(200);
    expect(mocks.search).toHaveBeenLastCalledWith(user, { q: 'a', limit: 20 });
    expect((await get(`?q=${'a'.repeat(200)}`)).status).toBe(200);
    expect(mocks.search).toHaveBeenLastCalledWith(user, { q: 'a'.repeat(200), limit: 20 });
    mocks.search.mockClear();

    const missing = await get('');
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe('validation_failed');
    expect((await get('?q=')).status).toBe(422);
    expect((await get(`?q=${'a'.repeat(201)}`)).status).toBe(422);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('accepts every known type in a comma list and rejects an unknown or empty type with 422', async () => {
    expect((await get('?q=anna&types=person,company,project,note,file')).status).toBe(200);
    expect(mocks.search).toHaveBeenLastCalledWith(user, {
      q: 'anna',
      types: ['person', 'company', 'project', 'note', 'file'],
      limit: 20,
    });
    expect((await get('?q=anna&types=file')).status).toBe(200);
    expect(mocks.search).toHaveBeenLastCalledWith(user, { q: 'anna', types: ['file'], limit: 20 });
    mocks.search.mockClear();

    const unknown = await get('?q=anna&types=person,summary');
    expect(unknown.status).toBe(422);
    expect(await errorCode(unknown)).toBe('validation_failed');
    expect((await get('?q=anna&types=')).status).toBe(422);
    expect((await get('?q=anna&types=person,')).status).toBe(422);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('rejects a non-integer or non-positive limit with 422 before the service', async () => {
    for (const limit of ['0', '-1', 'abc', '2.5']) {
      const res = await get(`?q=anna&limit=${limit}`);
      expect(res.status, `limit=${limit}`).toBe(422);
      expect(await errorCode(res)).toBe('validation_failed');
    }
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('rate limits 60 per minute per user and answers 429 without calling the service', async () => {
    await get('?q=anna');
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-search:u1', 60, 60);

    mocks.search.mockClear();
    mocks.rateLimit.mockRejectedValueOnce(new AppError('rate_limited'));
    const limited = await get('?q=anna');
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated and 403 when suspended, without calling the service', async () => {
    mocks.requireUser.mockRejectedValueOnce(new AppError('unauthenticated'));
    expect((await get('?q=anna')).status).toBe(401);
    mocks.requireUser.mockRejectedValueOnce(new AppError('account_suspended'));
    expect((await get('?q=anna')).status).toBe(403);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it('carries highlights as offset pairs and never HTML in any field', async () => {
    mocks.search.mockResolvedValue({ items: [noteItem, personItem], nextCursor: null });
    const res = await get('?q=thermostat');
    const text = await res.text();
    expect(text).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(text).not.toContain('&lt;');
    const body = JSON.parse(text) as { items: typeof noteItem[] };
    for (const item of body.items) {
      for (const snippet of item.snippets) {
        expect(typeof snippet.text).toBe('string');
        for (const h of snippet.highlights) {
          expect(h).toHaveLength(2);
          expect(h[0]).toEqual(expect.any(Number));
          expect(h[1]).toEqual(expect.any(Number));
          expect(h[0]!).toBeLessThan(h[1]!);
          expect(h[1]!).toBeLessThanOrEqual(snippet.text.length);
        }
      }
    }
    expect(body.items[0]!.snippets[0]!.text.slice(17, 27)).toBe('thermostat');
  });

  it('maps a service validation error (no usable token is not one: it returns an empty list) to 422', async () => {
    mocks.search.mockResolvedValueOnce(empty);
    const ok = await get('?q=%21%3F');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(empty);

    mocks.search.mockRejectedValueOnce(new AppError('validation_failed'));
    const bad = await get('?q=anna&cursor=broken');
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe('validation_failed');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as listRoute from '../app/api/hub/suggestions/route';
import * as countRoute from '../app/api/hub/suggestions/count/route';
import * as decideRoute from '../app/api/hub/suggestions/decide/route';

// Suggestion queue routes (contracts/http-api.md "Suggestions"; FR-023, FR-024). Merge-preview and merge routes
// (T140) get their own describe blocks at the end of this file.

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
  count: vi.fn(),
  decide: vi.fn(),
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/hub/suggestions', () => ({
  DECIDE_MAX_IDS: 200,
  list: mocks.list,
  count: mocks.count,
  decide: mocks.decide,
}));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const THREAD = '44444444-4444-4444-8444-444444444444';
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const noParams = { params: Promise.resolve({}) };

function getList(query = ''): Promise<Response> {
  return listRoute.GET(new Request(`http://x/api/hub/suggestions${query}`), noParams);
}

function getCount(): Promise<Response> {
  return countRoute.GET(new Request('http://x/api/hub/suggestions/count'), noParams);
}

function postDecide(body: unknown): Promise<Response> {
  return decideRoute.POST(
    new Request('http://x/api/hub/suggestions/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    noParams,
  );
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

const item = {
  id: ID,
  type: 'field',
  target: { kind: 'person', id: PERSON, label: 'Jan Kowalski' },
  field: 'roleTitle',
  proposed: 'CEO',
  current: 'CTO',
  conflict: true,
  reason: 'conflict',
  confidence: 0.74,
  dependsOn: null,
  sources: [
    {
      threadId: THREAD,
      subject: 'Kickoff',
      firstMessageAt: '2026-09-01T09:00:00.000Z',
      lastMessageAt: '2026-09-02T09:00:00.000Z',
      evidence: 'Signature: Jan Kowalski, CEO',
    },
  ],
  createdAt: '2026-09-02T10:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.count.mockResolvedValue({ pending: 0 });
  mocks.decide.mockResolvedValue({ results: [] });
});

describe('GET /api/hub/suggestions', () => {
  it('returns {items, nextCursor} in the contract shape and passes state, limit and cursor', async () => {
    mocks.list.mockResolvedValue({ items: [item], nextCursor: 'next' });
    const res = await getList('?state=suggested&limit=10&cursor=abc');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [item], nextCursor: 'next' });
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ['id', 'type', 'target', 'field', 'proposed', 'current', 'conflict', 'reason', 'confidence', 'dependsOn', 'sources', 'createdAt'].sort(),
    );
    expect(Object.keys(body.items[0].target).sort()).toEqual(['kind', 'id', 'label'].sort());
    expect(Object.keys(body.items[0].sources[0]).sort()).toEqual(
      ['threadId', 'subject', 'firstMessageAt', 'lastMessageAt', 'evidence'].sort(),
    );
    expect(mocks.list).toHaveBeenCalledWith(user, { state: 'suggested', limit: 10, cursor: 'abc' });
  });

  it('defaults to state=suggested and limit 25 without a cursor', async () => {
    const res = await getList();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
    expect(mocks.list).toHaveBeenCalledWith(user, { state: 'suggested', limit: 25 });
  });

  it('rejects another state, a limit outside 1..100 and a bad cursor with 422', async () => {
    for (const q of ['?state=rejected', '?limit=0', '?limit=101', '?limit=abc']) {
      const res = await getList(q);
      expect(res.status, q).toBe(422);
      expect(await errorCode(res)).toBe('validation_failed');
    }
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.list.mockRejectedValue(new AppError('validation_failed', 'Invalid cursor', { fields: ['cursor'] }));
    const bad = await getList('?cursor=nope');
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe('validation_failed');
  });

  it('requires a signed-in user', async () => {
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    expect((await getList()).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('GET /api/hub/suggestions/count', () => {
  it('returns {pending} for the badge', async () => {
    mocks.count.mockResolvedValue({ pending: 7 });
    const res = await getCount();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 7 });
    expect(mocks.count).toHaveBeenCalledWith(user);
  });

  it('requires a signed-in user', async () => {
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    expect((await getCount()).status).toBe(401);
    expect(mocks.count).not.toHaveBeenCalled();
  });
});

describe('POST /api/hub/suggestions/decide', () => {
  it('returns per-id results, including failures, without failing the call', async () => {
    const results = [
      { id: ID, status: 'accepted' },
      { id: ID2, status: 'failed', errorCode: 'suggestion_not_pending' },
    ];
    mocks.decide.mockResolvedValue({ results });
    const res = await postDecide({ ids: [ID, ID2], action: 'accept' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results });
    expect(mocks.decide).toHaveBeenCalledWith(user, { ids: [ID, ID2], action: 'accept' });
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-suggestions-decide:u1', 60, 60);
  });

  it('accepts reject and up to 200 ids', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => uuid(i));
    expect((await postDecide({ ids, action: 'reject' })).status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(user, { ids, action: 'reject' });
  });

  it("passes a foreign id through: the service answers it as a per-id not_found", async () => {
    mocks.decide.mockResolvedValue({ results: [{ id: ID, status: 'failed', errorCode: 'not_found' }] });
    const res = await postDecide({ ids: [ID], action: 'reject' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [{ id: ID, status: 'failed', errorCode: 'not_found' }] });
  });

  it('rejects 0 or 201 ids, a non-uuid id, an unknown action, extra keys and bad JSON with 422', async () => {
    const bad: unknown[] = [
      { ids: [], action: 'accept' },
      { ids: Array.from({ length: 201 }, (_, i) => uuid(i)), action: 'accept' },
      { ids: ['nope'], action: 'accept' },
      { ids: [ID], action: 'maybe' },
      { ids: [ID] },
      { ids: [ID], action: 'accept', extra: 1 },
      '{not json',
    ];
    for (const body of bad) {
      const res = await postDecide(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await errorCode(res)).toBe('validation_failed');
    }
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    expect((await postDecide({ ids: [ID], action: 'accept' })).status).toBe(401);
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Merge routes (T140): add the merge-preview and merge describe blocks below.

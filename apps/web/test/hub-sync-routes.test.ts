import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as syncRoute from '../app/api/hub/sync/route';
import * as retryRoute from '../app/api/hub/sync/retry/route';
import * as resyncRoute from '../app/api/hub/sync/resync/route';
import * as recordRoute from '../app/api/hub/[kind]/[id]/route';
import * as noteIdRoute from '../app/api/hub/notes/[id]/route';
import * as fileIdRoute from '../app/api/hub/files/[id]/route';

// Sync status, retry and re-sync of the memory-store copy (contracts/http-api.md "Sync"; FR-025, FR-026).

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  sync: { status: vi.fn(), retry: vi.fn(), resync: vi.fn() },
  records: { get: vi.fn(), deletePreview: vi.fn() },
  notes: { get: vi.fn() },
  files: { get: vi.fn() },
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/hub/sync', () => mocks.sync);
vi.mock('@voicespark/core/services/hub/records', () => mocks.records);
vi.mock('@voicespark/core/services/hub/notes', () => mocks.notes);
vi.mock('@voicespark/core/services/hub/files', () => mocks.files);

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const noParams = { params: Promise.resolve({}) };

function req(method: string, body?: unknown, url = 'http://x/api/hub/sync'): Request {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

const item = {
  id: ID,
  entityType: 'person',
  entityId: OTHER,
  label: 'Anna Nowak',
  status: 'failed',
  attempts: 3,
  lastErrorCode: 'store_unavailable',
  lastSyncedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/hub/sync', () => {
  it('returns counts and items and passes status and paging to the service', async () => {
    const result = {
      counts: { stored: 4, pending: 1, failed: 1 },
      items: [item],
      nextCursor: null,
    };
    mocks.sync.status.mockResolvedValue(result);
    const res = await syncRoute.GET(
      req('GET', undefined, 'http://x/api/hub/sync?status=failed&cursor=abc&limit=10'),
      noParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ stored: 4, pending: 1, failed: 1 });
    expect(body.items).toEqual([item]);
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'id',
        'entityType',
        'entityId',
        'label',
        'status',
        'attempts',
        'lastErrorCode',
        'lastSyncedAt',
      ].sort(),
    );
    expect(mocks.sync.status).toHaveBeenCalledWith(user, {
      status: 'failed',
      cursor: 'abc',
      limit: 10,
    });
  });

  it('lists every status with the default limit when no filter is given', async () => {
    mocks.sync.status.mockResolvedValue({
      counts: { stored: 0, pending: 0, failed: 0 },
      items: [],
      nextCursor: null,
    });
    const res = await syncRoute.GET(req('GET'), noParams);
    expect(res.status).toBe(200);
    expect(mocks.sync.status).toHaveBeenCalledWith(user, { limit: 25 });
  });

  it('rejects an unknown status and a bad limit with 422 before the service', async () => {
    const bad = await syncRoute.GET(
      req('GET', undefined, 'http://x/api/hub/sync?status=done'),
      noParams,
    );
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe('validation_failed');
    expect(
      (await syncRoute.GET(req('GET', undefined, 'http://x/api/hub/sync?limit=0'), noParams))
        .status,
    ).toBe(422);
    expect(mocks.sync.status).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated and 403 when suspended', async () => {
    mocks.requireUser.mockRejectedValueOnce(new AppError('unauthenticated'));
    expect((await syncRoute.GET(req('GET'), noParams)).status).toBe(401);
    mocks.requireUser.mockRejectedValueOnce(new AppError('account_suspended'));
    expect((await syncRoute.GET(req('GET'), noParams)).status).toBe(403);
    expect(mocks.sync.status).not.toHaveBeenCalled();
  });
});

describe('POST /api/hub/sync/retry', () => {
  it('requeues the given ids and returns 202 {requeued}', async () => {
    mocks.sync.retry.mockResolvedValue(2);
    const res = await retryRoute.POST(req('POST', { ids: [ID, OTHER] }), noParams);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requeued: 2 });
    expect(mocks.sync.retry).toHaveBeenCalledWith(user, [ID, OTHER]);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      'hub-sync:u1',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('retries every failed row without ids, with an empty object or no body at all', async () => {
    mocks.sync.retry.mockResolvedValue(5);
    const empty = await retryRoute.POST(req('POST', {}), noParams);
    expect(empty.status).toBe(202);
    expect(await empty.json()).toEqual({ requeued: 5 });
    expect(mocks.sync.retry).toHaveBeenLastCalledWith(user, undefined);

    const noBody = await retryRoute.POST(req('POST'), noParams);
    expect(noBody.status).toBe(202);
    expect(mocks.sync.retry).toHaveBeenLastCalledWith(user, undefined);
  });

  it('rejects non-uuid ids, a non-array ids and unknown keys with 422 before the service', async () => {
    expect((await retryRoute.POST(req('POST', { ids: ['nope'] }), noParams)).status).toBe(422);
    expect((await retryRoute.POST(req('POST', { ids: ID }), noParams)).status).toBe(422);
    expect((await retryRoute.POST(req('POST', { ids: [ID], all: true }), noParams)).status).toBe(
      422,
    );
    expect(mocks.sync.retry).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited and 401 from the guard, without calling the service', async () => {
    mocks.rateLimit.mockRejectedValueOnce(new AppError('rate_limited'));
    expect((await retryRoute.POST(req('POST', {}), noParams)).status).toBe(429);
    mocks.requireUser.mockRejectedValueOnce(new AppError('unauthenticated'));
    expect((await retryRoute.POST(req('POST', {}), noParams)).status).toBe(401);
    expect(mocks.sync.retry).not.toHaveBeenCalled();
  });
});

describe('POST /api/hub/sync/resync', () => {
  it('returns 202 {requeued} from the service (which audits hub.resync_requested)', async () => {
    mocks.sync.resync.mockResolvedValue(7);
    const res = await resyncRoute.POST(req('POST'), noParams);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requeued: 7 });
    expect(mocks.sync.resync).toHaveBeenCalledWith(user);
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      'hub-sync:u1',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('returns 429 when rate limited and 403 when suspended, without calling the service', async () => {
    mocks.rateLimit.mockRejectedValueOnce(new AppError('rate_limited'));
    expect((await resyncRoute.POST(req('POST'), noParams)).status).toBe(429);
    mocks.requireUser.mockRejectedValueOnce(new AppError('account_suspended'));
    expect((await resyncRoute.POST(req('POST'), noParams)).status).toBe(403);
    expect(mocks.sync.resync).not.toHaveBeenCalled();
  });
});

describe('sync field on record, note and file responses', () => {
  const sync = { status: 'stored', lastSyncedAt: '2026-01-02T00:00:00.000Z' };

  it('GET /api/hub/{kind}/{id} carries {sync: {status, lastSyncedAt}}', async () => {
    mocks.records.get.mockResolvedValue({ record: { id: ID, name: 'Anna' }, links: [], sync });
    const res = await recordRoute.GET(req('GET', undefined, `http://x/api/hub/people/${ID}`), {
      params: Promise.resolve({ kind: 'people', id: ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sync).toEqual(sync);
  });

  it('GET /api/hub/notes/{id} and /api/hub/files/{id} carry the sync field', async () => {
    mocks.notes.get.mockResolvedValue({ id: ID, title: 'Call', sync });
    const note = await noteIdRoute.GET(req('GET'), { params: Promise.resolve({ id: ID }) });
    expect((await note.json()).note.sync).toEqual(sync);

    mocks.files.get.mockResolvedValue({ id: ID, name: 'offer.pdf', sync });
    const file = await fileIdRoute.GET(req('GET'), { params: Promise.resolve({ id: ID }) });
    expect((await file.json()).sync).toEqual(sync);
  });
});

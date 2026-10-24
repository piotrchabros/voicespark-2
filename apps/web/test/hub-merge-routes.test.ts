import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as previewRoute from '../app/api/hub/[kind]/[id]/merge-preview/route';
import * as mergeRoute from '../app/api/hub/[kind]/[id]/merge/route';

// Merge preview and merge (contracts/http-api.md "GET /api/hub/{kind}/{id}/merge-preview" and
// "POST /api/hub/{kind}/{id}/merge"; US4; FR-005).

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  merge: { preview: vi.fn(), merge: vi.fn() },
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/hub/merge', () => mocks.merge);

const user = { userId: 'u1', role: 'user' as const };
const KEPT = '44444444-4444-4444-8444-444444444444';
const SOURCE = '55555555-5555-4555-8555-555555555555';

const params = (kind = 'people', id = KEPT) => ({ params: Promise.resolve({ kind, id }) });

function req(method: string, body?: unknown, query = ''): Request {
  return new Request(`http://x/api/hub/people/${KEPT}/merge${query}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

const notFound = () => new AppError('not_found', undefined, undefined, 404);

const preview = {
  moves: { emails: 1, domains: 0, notes: 2, files: 1, links: 1, linkDuplicates: 1, summaries: 3, facts: 4 },
  keptValues: ['name'],
  filledValues: ['phone'],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/hub/{kind}/{id}/merge-preview', () => {
  it('returns the preview in the contract shape', async () => {
    mocks.merge.preview.mockResolvedValue(preview);
    const res = await previewRoute.GET(req('GET', undefined, `?sourceId=${SOURCE}`), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(preview);
    expect(Object.keys(body).sort()).toEqual(['filledValues', 'keptValues', 'moves']);
    expect(Object.keys(body.moves).sort()).toEqual(
      ['emails', 'domains', 'notes', 'files', 'links', 'linkDuplicates', 'summaries', 'facts'].sort(),
    );
    expect(mocks.merge.preview).toHaveBeenCalledWith(user, 'person', KEPT, SOURCE);
  });

  it('answers 422 without sourceId and 404 for an unknown kind', async () => {
    const bad = await previewRoute.GET(req('GET'), params());
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe('validation_failed');
    const kind = await previewRoute.GET(req('GET', undefined, `?sourceId=${SOURCE}`), params('notes'));
    expect(kind.status).toBe(404);
    expect(mocks.merge.preview).not.toHaveBeenCalled();
  });

  it('answers 404 and audits both ids on a miss', async () => {
    mocks.merge.preview.mockRejectedValueOnce(notFound());
    const res = await previewRoute.GET(req('GET', undefined, `?sourceId=${SOURCE}`), params('companies'));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_company', KEPT);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_company', SOURCE);
  });

  it('answers 409 merge_invalid without an audit', async () => {
    mocks.merge.preview.mockRejectedValueOnce(new AppError('merge_invalid'));
    const res = await previewRoute.GET(req('GET', undefined, `?sourceId=${KEPT}`), params());
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('merge_invalid');
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mocks.requireUser.mockRejectedValueOnce(new AppError('unauthenticated'));
    expect((await previewRoute.GET(req('GET', undefined, `?sourceId=${SOURCE}`), params())).status).toBe(401);
    expect(mocks.merge.preview).not.toHaveBeenCalled();
  });
});

describe('POST /api/hub/{kind}/{id}/merge', () => {
  const record = { id: KEPT, name: 'Jan Kowalski', emails: [] };

  it('merges the source into the record and returns {record}', async () => {
    mocks.merge.merge.mockResolvedValue({ record });
    const res = await mergeRoute.POST(req('POST', { sourceId: SOURCE }), params('projects'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ record });
    expect(mocks.merge.merge).toHaveBeenCalledWith(user, 'project', KEPT, SOURCE);
    expect(mocks.rateLimit).toHaveBeenCalledWith(`hub-records:${user.userId}`, expect.any(Number), expect.any(Number));
  });

  it('answers 422 for a missing sourceId or unknown keys', async () => {
    for (const body of [{}, { sourceId: SOURCE, extra: 1 }, { sourceId: 7 }]) {
      const res = await mergeRoute.POST(req('POST', body), params());
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe('validation_failed');
    }
    expect(mocks.merge.merge).not.toHaveBeenCalled();
  });

  it('answers 409 merge_invalid for the same id or another kind', async () => {
    mocks.merge.merge.mockRejectedValueOnce(new AppError('merge_invalid'));
    const res = await mergeRoute.POST(req('POST', { sourceId: KEPT }), params());
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('merge_invalid');
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });

  it('answers 404 and audits both ids on a miss', async () => {
    mocks.merge.merge.mockRejectedValueOnce(notFound());
    const res = await mergeRoute.POST(req('POST', { sourceId: SOURCE }), params());
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_person', KEPT);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_person', SOURCE);
  });

  it('answers 404 for an unknown kind', async () => {
    const res = await mergeRoute.POST(req('POST', { sourceId: SOURCE }), params('files'));
    expect(res.status).toBe(404);
    expect(mocks.merge.merge).not.toHaveBeenCalled();
  });
});

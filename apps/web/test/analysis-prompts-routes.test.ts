import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as listRoute from '../app/api/analysis-prompts/route';
import * as detailRoute from '../app/api/analysis-prompts/[definitionId]/route';
import * as customiseRoute from '../app/api/analysis-prompts/[definitionId]/customise/route';
import * as resetRoute from '../app/api/analysis-prompts/[definitionId]/reset/route';
import * as versionsRoute from '../app/api/analysis-prompts/[definitionId]/versions/route';
import * as versionRoute from '../app/api/analysis-prompts/[definitionId]/versions/[versionId]/route';
import * as compareRoute from '../app/api/analysis-prompts/[definitionId]/compare/route';
import * as changesRoute from '../app/api/analysis-prompts/[definitionId]/default-changes/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  customise: vi.fn(),
  save: vi.fn(),
  reset: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  compare: vi.fn(),
  defaultChanges: vi.fn(),
}));

vi.mock('../lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@voicespark/core/services/own-prompts', () => ({
  list: mocks.list,
  get: mocks.get,
  customise: mocks.customise,
  save: mocks.save,
  reset: mocks.reset,
  listVersions: mocks.listVersions,
  getVersion: mocks.getVersion,
  compare: mocks.compare,
  defaultChanges: mocks.defaultChanges,
}));

const user = { userId: 'u1', role: 'user' as const };
const DEF = '11111111-1111-4111-8111-111111111111';
const VER = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ definitionId: DEF }) };
const versionParams = { params: Promise.resolve({ definitionId: DEF, versionId: VER }) };
const put = (body: unknown) =>
  new Request('http://x', { method: 'PUT', body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/analysis-prompts', () => {
  it('lists for the user', async () => {
    mocks.list.mockResolvedValue([{ profileId: null }]);
    const res = await listRoute.GET(new Request('http://x'), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ profileId: null }]);
    expect(mocks.list).toHaveBeenCalledWith(user);
  });

  it('requires a user', async () => {
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    expect((await listRoute.GET(new Request('http://x'), undefined)).status).toBe(401);
  });
});

describe('/api/analysis-prompts/[definitionId]', () => {
  it('GET returns the detail', async () => {
    mocks.get.mockResolvedValue({ own: null });
    const res = await detailRoute.GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(user, DEF);
  });

  it('GET maps not_found to 404', async () => {
    mocks.get.mockRejectedValue(new AppError('not_found'));
    expect((await detailRoute.GET(new Request('http://x'), params)).status).toBe(404);
  });

  it('PUT saves a new version with 201', async () => {
    mocks.save.mockResolvedValue({ own: { id: 'o1' } });
    const res = await detailRoute.PUT(put({ promptText: 'hi', baseVersionId: VER }), params);
    expect(res.status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith(user, DEF, { promptText: 'hi', baseVersionId: VER });
  });

  it('PUT rejects a malformed body with 422', async () => {
    const res = await detailRoute.PUT(put({ promptText: 'hi', baseVersionId: 'x' }), params);
    expect(res.status).toBe(422);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('PUT passes service errors through (stale editor is 409)', async () => {
    mocks.save.mockRejectedValue(new AppError('conflict'));
    const res = await detailRoute.PUT(put({ promptText: 'hi', baseVersionId: VER }), params);
    expect(res.status).toBe(409);
  });
});

describe('customise and reset', () => {
  it('customise returns 201', async () => {
    mocks.customise.mockResolvedValue({ own: { id: 'o1', inUse: true } });
    const res = await customiseRoute.POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(201);
    expect(mocks.customise).toHaveBeenCalledWith(user, DEF);
  });

  it('customise maps conflict to 409', async () => {
    mocks.customise.mockRejectedValue(new AppError('conflict'));
    const res = await customiseRoute.POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(409);
  });

  it('reset returns 200', async () => {
    mocks.reset.mockResolvedValue({ own: { id: 'o1', inUse: false } });
    const res = await resetRoute.POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ own: { id: 'o1', inUse: false } });
  });

  it('reset without an own prompt is 404', async () => {
    mocks.reset.mockRejectedValue(new AppError('not_found'));
    const res = await resetRoute.POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(404);
  });
});

describe('versions', () => {
  it('lists versions', async () => {
    mocks.listVersions.mockResolvedValue([]);
    const res = await versionsRoute.GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.listVersions).toHaveBeenCalledWith(user, DEF);
  });

  it('returns one version', async () => {
    mocks.getVersion.mockResolvedValue({ id: VER, promptText: 'p' });
    const res = await versionRoute.GET(new Request('http://x'), versionParams);
    expect(res.status).toBe(200);
    expect(mocks.getVersion).toHaveBeenCalledWith(user, DEF, VER);
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });

  it('audits foreign access on 404', async () => {
    mocks.getVersion.mockRejectedValue(new AppError('not_found'));
    const res = await versionRoute.GET(new Request('http://x'), versionParams);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'own_prompt_version', VER);
  });

  it('does not audit other errors', async () => {
    mocks.getVersion.mockRejectedValue(new AppError('conflict'));
    await versionRoute.GET(new Request('http://x'), versionParams);
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });
});

describe('compare and default-changes', () => {
  it('compare returns the diff', async () => {
    mocks.compare.mockResolvedValue({ diff: [] });
    const res = await compareRoute.GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.compare).toHaveBeenCalledWith(user, DEF);
  });

  it('compare without an own prompt is 404', async () => {
    mocks.compare.mockRejectedValue(new AppError('not_found'));
    expect((await compareRoute.GET(new Request('http://x'), params)).status).toBe(404);
  });

  it('default-changes passes from and to', async () => {
    mocks.defaultChanges.mockResolvedValue({ diff: [] });
    const res = await changesRoute.GET(new Request(`http://x/?from=${VER}&to=${DEF}`), params);
    expect(res.status).toBe(200);
    expect(mocks.defaultChanges).toHaveBeenCalledWith(user, DEF, VER, DEF);
  });

  it('default-changes passes undefined when params are missing', async () => {
    mocks.defaultChanges.mockRejectedValue(new AppError('validation_failed'));
    const res = await changesRoute.GET(new Request('http://x/'), params);
    expect(res.status).toBe(422);
    expect(mocks.defaultChanges).toHaveBeenCalledWith(user, DEF, undefined, undefined);
  });
});

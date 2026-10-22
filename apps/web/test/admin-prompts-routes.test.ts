import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as adminPromptsRoute from '../app/api/admin/prompts/route';
import * as adminPromptsIdRoute from '../app/api/admin/prompts/[id]/route';
import * as adminPromptsIdVersionsRoute from '../app/api/admin/prompts/[id]/versions/route';
import * as adminPromptsIdVersionsVersionIdRoute from '../app/api/admin/prompts/[id]/versions/[versionId]/route';
import * as adminPromptsIdVersionsVersionIdPublishRoute from '../app/api/admin/prompts/[id]/versions/[versionId]/publish/route';
import * as adminPromptsIdVersionsVersionIdDiffRoute from '../app/api/admin/prompts/[id]/versions/[versionId]/diff/route';
import * as adminPromptsIdVersionsVersionIdValidateRoute from '../app/api/admin/prompts/[id]/versions/[versionId]/validate/route';
import * as adminPromptsIdVersionsVersionIdPreviewRoute from '../app/api/admin/prompts/[id]/versions/[versionId]/preview/route';
import * as adminPromptsIdRollbackRoute from '../app/api/admin/prompts/[id]/rollback/route';
import * as adminPromptsIdHistoryRoute from '../app/api/admin/prompts/[id]/history/route';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  adminList: vi.fn(),
  adminGet: vi.fn(),
  create: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  discardDraft: vi.fn(),
  publish: vi.fn(),
  diff: vi.fn(),
  validate: vi.fn(),
  preview: vi.fn(),
  rollback: vi.fn(),
  history: vi.fn(),
}));

vi.mock('../lib/guards', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@voicespark/core/services/prompts', () => ({
  adminList: mocks.adminList,
  adminGet: mocks.adminGet,
  create: mocks.create,
  createDraft: mocks.createDraft,
  updateDraft: mocks.updateDraft,
  discardDraft: mocks.discardDraft,
  publish: mocks.publish,
  diff: mocks.diff,
  validate: mocks.validate,
  preview: mocks.preview,
  rollback: mocks.rollback,
  history: mocks.history,
}));

const admin = { userId: '00000000-0000-4000-8000-000000000001', role: 'admin' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: ID }) };
const vparams = { params: Promise.resolve({ id: ID, versionId: VID }) };
const created = new Date('2026-01-01T00:00:00.000Z');

const listItem = {
  id: ID,
  key: 'draft_generation',
  isSystem: false,
  description: 'desc',
  activeVersion: { id: VID, versionNumber: 1, model: 'claude-x' },
  draftVersionId: null,
};
const version = {
  id: VID,
  versionNumber: 2,
  status: 'draft',
  systemTemplate: 'sys {{a}}',
  userTemplate: 'user {{b}}',
  model: 'claude-x',
  effort: 'medium',
  maxTokens: 1000,
  changeNote: null,
  createdAt: created,
  createdBy: admin.userId,
  publishedAt: null,
  publishedBy: null,
};
const createInput = {
  key: 'new_prompt',
  description: 'd',
  systemTemplate: 's',
  userTemplate: 'u',
  model: 'claude-x',
  effort: 'low',
  maxTokens: 500,
};
const post = (body?: unknown) =>
  new Request('http://x', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patchReq = (body: unknown) =>
  new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue(admin);
});

describe('GET/POST /api/admin/prompts', () => {
  it('lists prompts', async () => {
    mocks.adminList.mockResolvedValue([listItem]);
    const { GET } = adminPromptsRoute;
    const res = await GET(new Request('http://x'), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([listItem]);
  });

  it('returns 403 for non-admins', async () => {
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    const { GET, POST } = adminPromptsRoute;
    expect((await GET(new Request('http://x'), undefined)).status).toBe(403);
    expect((await POST(post(createInput), undefined)).status).toBe(403);
    expect(mocks.adminList).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('fails closed when the service returns an undeclared field', async () => {
    mocks.adminList.mockResolvedValue([{ ...listItem, bodyText: 'leak' }]);
    const { GET } = adminPromptsRoute;
    const res = await GET(new Request('http://x'), undefined);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('leak');
  });

  it('creates a prompt with 201', async () => {
    mocks.create.mockResolvedValue({ prompt: listItem, draft: version });
    const { POST } = adminPromptsRoute;
    const res = await POST(post(createInput), undefined);
    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(admin.userId, createInput);
    expect((await res.json()).draft.createdAt).toBe(created.toISOString());
  });

  it('rejects invalid or unknown create fields with 422', async () => {
    const { POST } = adminPromptsRoute;
    expect((await POST(post({ ...createInput, effort: 'extreme' }), undefined)).status).toBe(422);
    expect((await POST(post({ ...createInput, maxTokens: 0 }), undefined)).status).toBe(422);
    expect((await POST(post({ ...createInput, extra: 1 }), undefined)).status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/prompts/[id]', () => {
  it('returns the prompt with versions', async () => {
    mocks.adminGet.mockResolvedValue({ prompt: listItem, versions: [version] });
    const { GET } = adminPromptsIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.adminGet).toHaveBeenCalledWith(ID);
    expect((await res.json()).versions).toHaveLength(1);
  });

  it('returns 404 and 403', async () => {
    const { GET } = adminPromptsIdRoute;
    mocks.adminGet.mockRejectedValue(new AppError('not_found'));
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await GET(new Request('http://x'), params)).status).toBe(403);
  });
});

describe('POST /api/admin/prompts/[id]/versions', () => {
  it('accepts an empty body', async () => {
    mocks.createDraft.mockResolvedValue(version);
    const { POST } = adminPromptsIdVersionsRoute;
    const res = await POST(post(), params);
    expect(res.status).toBe(201);
    expect(mocks.createDraft).toHaveBeenCalledWith(admin.userId, ID, undefined);
  });

  it('passes fromVersionId, validates it, and rejects unknown keys', async () => {
    mocks.createDraft.mockResolvedValue(version);
    const { POST } = adminPromptsIdVersionsRoute;
    expect((await POST(post({ fromVersionId: OTHER }), params)).status).toBe(201);
    expect(mocks.createDraft).toHaveBeenCalledWith(admin.userId, ID, OTHER);
    expect((await POST(post({ fromVersionId: 'nope' }), params)).status).toBe(422);
    expect((await POST(post({ other: 1 }), params)).status).toBe(422);
    expect(mocks.createDraft).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-JSON body with 422', async () => {
    const { POST } = adminPromptsIdVersionsRoute;
    const res = await POST(new Request('http://x', { method: 'POST', body: 'not json' }), params);
    expect(res.status).toBe(422);
  });

  it('maps conflict and 403', async () => {
    const { POST } = adminPromptsIdVersionsRoute;
    mocks.createDraft.mockRejectedValue(new AppError('conflict'));
    expect((await POST(post(), params)).status).toBe(409);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await POST(post(), params)).status).toBe(403);
  });
});

describe('PATCH/DELETE /api/admin/prompts/[id]/versions/[versionId]', () => {
  it('patches a draft', async () => {
    mocks.updateDraft.mockResolvedValue(version);
    const { PATCH } = adminPromptsIdVersionsVersionIdRoute;
    const res = await PATCH(patchReq({ model: 'm', changeNote: null }), vparams);
    expect(res.status).toBe(200);
    expect(mocks.updateDraft).toHaveBeenCalledWith(admin.userId, ID, VID, {
      model: 'm',
      changeNote: null,
    });
  });

  it('rejects invalid patches with 422', async () => {
    const { PATCH } = adminPromptsIdVersionsVersionIdRoute;
    expect((await PATCH(patchReq({ effort: 'extreme' }), vparams)).status).toBe(422);
    expect((await PATCH(patchReq({ systemTemplate: '' }), vparams)).status).toBe(422);
    expect((await PATCH(patchReq({ unknown: 1 }), vparams)).status).toBe(422);
    expect(mocks.updateDraft).not.toHaveBeenCalled();
  });

  it('maps not_found and 403 on patch', async () => {
    const { PATCH } = adminPromptsIdVersionsVersionIdRoute;
    mocks.updateDraft.mockRejectedValue(new AppError('not_found'));
    expect((await PATCH(patchReq({}), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await PATCH(patchReq({}), vparams)).status).toBe(403);
  });

  it('discards a draft with 204', async () => {
    mocks.discardDraft.mockResolvedValue(undefined);
    const { DELETE } = adminPromptsIdVersionsVersionIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), vparams);
    expect(res.status).toBe(204);
    expect(mocks.discardDraft).toHaveBeenCalledWith(admin.userId, ID, VID);
  });

  it('delete maps not_found and 403', async () => {
    const { DELETE } = adminPromptsIdVersionsVersionIdRoute;
    mocks.discardDraft.mockRejectedValue(new AppError('not_found'));
    expect((await DELETE(new Request('http://x'), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await DELETE(new Request('http://x'), vparams)).status).toBe(403);
  });
});

describe('publish / diff / validate / preview', () => {
  it('publishes a version', async () => {
    mocks.publish.mockResolvedValue(listItem);
    const { POST } = adminPromptsIdVersionsVersionIdPublishRoute;
    const res = await POST(post(), vparams);
    expect(res.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith(admin.userId, ID, VID);
    expect(await res.json()).toEqual({ prompt: listItem });
  });

  it('publish maps validation failure, 404 and 403', async () => {
    const { POST } = adminPromptsIdVersionsVersionIdPublishRoute;
    mocks.publish.mockRejectedValue(new AppError('validation_failed'));
    expect((await POST(post(), vparams)).status).toBe(422);
    mocks.publish.mockRejectedValue(new AppError('not_found'));
    expect((await POST(post(), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await POST(post(), vparams)).status).toBe(403);
  });

  it('diffs and requires a uuid `against`', async () => {
    const result = {
      from: { id: OTHER, versionNumber: 1 },
      to: { id: VID, versionNumber: 2 },
      changes: [{ path: 'model', op: 'changed', before: 'a', after: 'b' }],
    };
    mocks.diff.mockResolvedValue(result);
    const { GET } = adminPromptsIdVersionsVersionIdDiffRoute;
    const ok = await GET(new Request(`http://x/d?against=${OTHER}`), vparams);
    expect(ok.status).toBe(200);
    expect(mocks.diff).toHaveBeenCalledWith(ID, VID, OTHER);
    expect(await ok.json()).toEqual(result);
    expect((await GET(new Request('http://x/d'), vparams)).status).toBe(422);
    expect((await GET(new Request('http://x/d?against=nope'), vparams)).status).toBe(422);
    expect(mocks.diff).toHaveBeenCalledTimes(1);
  });

  it('validates a version', async () => {
    const result = { valid: false, unknownVariables: ['x'], missingRequired: ['y'] };
    mocks.validate.mockResolvedValue(result);
    const { POST } = adminPromptsIdVersionsVersionIdValidateRoute;
    const res = await POST(post(), vparams);
    expect(res.status).toBe(200);
    expect(mocks.validate).toHaveBeenCalledWith(VID);
    expect(await res.json()).toEqual(result);
  });

  it('validate maps 404 and 403', async () => {
    const { POST } = adminPromptsIdVersionsVersionIdValidateRoute;
    mocks.validate.mockRejectedValue(new AppError('not_found'));
    expect((await POST(post(), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await POST(post(), vparams)).status).toBe(403);
  });

  it('previews with an empty body', async () => {
    mocks.preview.mockResolvedValue({ system: 's', user: 'u' });
    const { POST } = adminPromptsIdVersionsVersionIdPreviewRoute;
    const res = await POST(post(), vparams);
    expect(res.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith(VID, {});
    expect(await res.json()).toEqual({ system: 's', user: 'u' });
  });

  it('previews with isRevision and validates the body', async () => {
    mocks.preview.mockResolvedValue({ system: 's', user: 'u' });
    const { POST } = adminPromptsIdVersionsVersionIdPreviewRoute;
    expect((await POST(post({ isRevision: true }), vparams)).status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith(VID, { isRevision: true });
    expect((await POST(post({ isRevision: 'yes' }), vparams)).status).toBe(422);
    expect((await POST(post({ other: 1 }), vparams)).status).toBe(422);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });

  it('preview maps 404 and 403', async () => {
    const { POST } = adminPromptsIdVersionsVersionIdPreviewRoute;
    mocks.preview.mockRejectedValue(new AppError('not_found'));
    expect((await POST(post(), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await POST(post(), vparams)).status).toBe(403);
  });
});

describe('rollback / history', () => {
  it('rolls back', async () => {
    mocks.rollback.mockResolvedValue(listItem);
    const { POST } = adminPromptsIdRollbackRoute;
    const res = await POST(post({ versionId: VID }), params);
    expect(res.status).toBe(200);
    expect(mocks.rollback).toHaveBeenCalledWith(admin.userId, ID, VID);
    expect(await res.json()).toEqual({ prompt: listItem });
  });

  it('rollback validates the body and maps not_found', async () => {
    const { POST } = adminPromptsIdRollbackRoute;
    expect((await POST(post({}), params)).status).toBe(422);
    expect((await POST(post({ versionId: 'x' }), params)).status).toBe(422);
    expect(mocks.rollback).not.toHaveBeenCalled();
    mocks.rollback.mockRejectedValue(new AppError('not_found'));
    expect((await POST(post({ versionId: VID }), params)).status).toBe(404);
  });

  it('returns history entries', async () => {
    mocks.history.mockResolvedValue([
      {
        action: 'rollback',
        fromVersion: { id: OTHER, versionNumber: 2 },
        toVersion: { id: VID, versionNumber: 1 },
        actor: { id: admin.userId, name: null },
        occurredAt: created,
      },
    ]);
    const { GET } = adminPromptsIdHistoryRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.history).toHaveBeenCalledWith(ID);
    expect((await res.json())[0].occurredAt).toBe(created.toISOString());
  });

  it('history returns 404 and 403', async () => {
    const { GET } = adminPromptsIdHistoryRoute;
    mocks.history.mockRejectedValue(new AppError('not_found'));
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await GET(new Request('http://x'), params)).status).toBe(403);
  });
});

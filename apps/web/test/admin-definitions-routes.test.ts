import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as adminDefinitionsRoute from '../app/api/admin/definitions/route';
import * as adminDefinitionsIdRoute from '../app/api/admin/definitions/[id]/route';
import * as adminDefinitionsIdVersionsRoute from '../app/api/admin/definitions/[id]/versions/route';
import * as adminDefinitionsIdVersionsVersionIdRoute from '../app/api/admin/definitions/[id]/versions/[versionId]/route';
import * as adminDefinitionsIdVersionsVersionIdPublishRoute from '../app/api/admin/definitions/[id]/versions/[versionId]/publish/route';
import * as adminDefinitionsIdVersionsVersionIdDiffRoute from '../app/api/admin/definitions/[id]/versions/[versionId]/diff/route';
import * as adminDefinitionsIdRollbackRoute from '../app/api/admin/definitions/[id]/rollback/route';
import * as adminDefinitionsIdAvailabilityRoute from '../app/api/admin/definitions/[id]/availability/route';
import * as adminDefinitionsIdHistoryRoute from '../app/api/admin/definitions/[id]/history/route';
import * as adminDefinitionsIdVersionsVersionIdPreviewRoute from '../app/api/admin/definitions/[id]/versions/[versionId]/preview/route';
import * as adminDefinitionsIdVersionsVersionIdPreviewRunRoute from '../app/api/admin/definitions/[id]/versions/[versionId]/preview-run/route';
import * as adminDefinitionsIdVersionsVersionIdPreviewRunJobIdRoute from '../app/api/admin/definitions/[id]/versions/[versionId]/preview-run/[jobId]/route';

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
  rollback: vi.fn(),
  setAvailability: vi.fn(),
  history: vi.fn(),
  adminGetVersion: vi.fn(),
  previewDefinitionVersion: vi.fn(),
  startPreviewRun: vi.fn(),
  getPreviewRun: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock('../lib/guards', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('../lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/prompts', () => ({
  previewDefinitionVersion: mocks.previewDefinitionVersion,
}));
vi.mock('@voicespark/core/services/analysis-preview', () => ({
  startPreviewRun: mocks.startPreviewRun,
  getPreviewRun: mocks.getPreviewRun,
}));
vi.mock('@voicespark/core/services/definitions', () => ({
  adminList: mocks.adminList,
  adminGet: mocks.adminGet,
  create: mocks.create,
  createDraft: mocks.createDraft,
  updateDraft: mocks.updateDraft,
  discardDraft: mocks.discardDraft,
  publish: mocks.publish,
  diff: mocks.diff,
  rollback: mocks.rollback,
  setAvailability: mocks.setAvailability,
  history: mocks.history,
  adminGetVersion: mocks.adminGetVersion,
}));

const admin = { userId: '00000000-0000-4000-8000-000000000001', role: 'admin' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: ID }) };
const vparams = { params: Promise.resolve({ id: ID, versionId: VID }) };
const created = new Date('2026-01-01T00:00:00.000Z');

const dimension = {
  key: 'warmth',
  name: 'Warmth',
  description: 'How warm',
  valueType: 'scale',
  scale: { min: 1, max: 5, minLabel: 'cold', maxLabel: 'warm' },
};
const listItem = {
  id: ID,
  key: 'tone',
  availability: 'available',
  activeVersion: { id: VID, versionNumber: 1, name: 'Tone' },
  draftVersionId: null,
  userChoiceCount: 3,
  ownPromptCount: 1,
};
const version = {
  id: VID,
  versionNumber: 2,
  status: 'draft',
  name: 'Tone',
  description: 'desc',
  dimensions: [dimension],
  createdAt: created,
  createdBy: admin.userId,
  publishedAt: null,
  publishedBy: null,
  analysisPrompt: 'Describe the tone.',
};
const post = (body?: unknown) =>
  new Request('http://x', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue(admin);
});

describe('GET/POST /api/admin/definitions', () => {
  it('lists definitions', async () => {
    mocks.adminList.mockResolvedValue([listItem]);
    const { GET } = adminDefinitionsRoute;
    const res = await GET(new Request('http://x'), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([listItem]);
  });

  it('returns 403 for non-admins', async () => {
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    const { GET, POST } = adminDefinitionsRoute;
    expect((await GET(new Request('http://x'), undefined)).status).toBe(403);
    expect((await POST(post({}), undefined)).status).toBe(403);
    expect(mocks.adminList).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('fails closed when the service returns an undeclared field', async () => {
    mocks.adminList.mockResolvedValue([{ ...listItem, bodyText: 'leak' }]);
    const { GET } = adminDefinitionsRoute;
    const res = await GET(new Request('http://x'), undefined);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('leak');
  });

  it('creates a definition with 201', async () => {
    mocks.create.mockResolvedValue({ definition: listItem, draft: version });
    const { POST } = adminDefinitionsRoute;
    const input = { key: 'tone', name: 'Tone', description: 'd', analysisPrompt: 'Describe.' };
    const res = await POST(post(input), undefined);
    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(admin.userId, input);
    const json = await res.json();
    expect(json.draft.createdAt).toBe(created.toISOString());
  });

  it('rejects an invalid create body with 422', async () => {
    const { POST } = adminDefinitionsRoute;
    const res = await POST(post({ key: 'tone', name: 'Tone', analysisPrompt: 1 }), undefined);
    expect(res.status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('passes dimensions to the service, which rejects them with details.field', async () => {
    mocks.create.mockRejectedValue(
      new AppError('validation_failed', undefined, { field: 'dimensions' }),
    );
    const { POST } = adminDefinitionsRoute;
    const input = { key: 'tone', name: 'Tone', description: 'd', dimensions: [dimension] };
    const res = await POST(post(input), undefined);
    expect(res.status).toBe(422);
    expect(mocks.create).toHaveBeenCalledWith(admin.userId, input);
    expect((await res.json()).error.details).toEqual({ field: 'dimensions' });
  });

  it('accepts a null analysisPrompt and maps too_long', async () => {
    const details = { field: 'analysisPrompt', reason: 'too_long', maxChars: 20000 };
    mocks.create.mockRejectedValue(new AppError('validation_failed', undefined, details));
    const { POST } = adminDefinitionsRoute;
    const input = { key: 'tone', name: 'Tone', description: 'd', analysisPrompt: null };
    const res = await POST(post(input), undefined);
    expect(res.status).toBe(422);
    expect(mocks.create).toHaveBeenCalledWith(admin.userId, input);
    expect((await res.json()).error.details).toEqual(details);
  });

  it('list items without ownPromptCount fail closed', async () => {
    const { ownPromptCount: _omit, ...legacy } = listItem;
    mocks.adminList.mockResolvedValue([legacy]);
    const { GET } = adminDefinitionsRoute;
    expect((await GET(new Request('http://x'), undefined)).status).toBe(500);
  });

  it('maps a service conflict', async () => {
    mocks.create.mockRejectedValue(new AppError('conflict'));
    const { POST } = adminDefinitionsRoute;
    const res = await POST(
      post({ key: 'tone', name: 'Tone', description: 'd', analysisPrompt: 'Describe.' }),
      undefined,
    );
    expect(res.status).toBe(409);
  });
});

describe('GET /api/admin/definitions/[id]', () => {
  it('returns the definition with its versions', async () => {
    mocks.adminGet.mockResolvedValue({ definition: listItem, versions: [version] });
    const { GET } = adminDefinitionsIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.adminGet).toHaveBeenCalledWith(ID);
    expect((await res.json()).versions).toHaveLength(1);
  });

  it('returns 404 for a missing definition', async () => {
    mocks.adminGet.mockRejectedValue(new AppError('not_found'));
    const { GET } = adminDefinitionsIdRoute;
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
  });

  it('returns 403 for non-admins', async () => {
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    const { GET } = adminDefinitionsIdRoute;
    expect((await GET(new Request('http://x'), params)).status).toBe(403);
    expect(mocks.adminGet).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/definitions/[id]/versions', () => {
  it('accepts an empty body and drafts from the active version', async () => {
    mocks.createDraft.mockResolvedValue(version);
    const { POST } = adminDefinitionsIdVersionsRoute;
    const res = await POST(post(), params);
    expect(res.status).toBe(201);
    expect(mocks.createDraft).toHaveBeenCalledWith(admin.userId, ID, undefined);
    expect((await res.json()).version.id).toBe(VID);
  });

  it('passes fromVersionId and validates it', async () => {
    mocks.createDraft.mockResolvedValue(version);
    const { POST } = adminDefinitionsIdVersionsRoute;
    expect((await POST(post({ fromVersionId: OTHER }), params)).status).toBe(201);
    expect(mocks.createDraft).toHaveBeenCalledWith(admin.userId, ID, OTHER);
    expect((await POST(post({ fromVersionId: 'nope' }), params)).status).toBe(422);
    expect(mocks.createDraft).toHaveBeenCalledTimes(1);
  });

  it('maps an existing-draft conflict and 404', async () => {
    const { POST } = adminDefinitionsIdVersionsRoute;
    mocks.createDraft.mockRejectedValueOnce(new AppError('conflict'));
    expect((await POST(post(), params)).status).toBe(409);
    mocks.createDraft.mockRejectedValueOnce(new AppError('not_found'));
    expect((await POST(post(), params)).status).toBe(404);
  });
});

describe('PATCH/DELETE /api/admin/definitions/[id]/versions/[versionId]', () => {
  it('patches a draft', async () => {
    mocks.updateDraft.mockResolvedValue(version);
    const { PATCH } = adminDefinitionsIdVersionsVersionIdRoute;
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'New' }) }),
      vparams,
    );
    expect(res.status).toBe(200);
    expect(mocks.updateDraft).toHaveBeenCalledWith(admin.userId, ID, VID, { name: 'New' });
  });

  it('patches the analysis prompt', async () => {
    mocks.updateDraft.mockResolvedValue(version);
    const { PATCH } = adminDefinitionsIdVersionsVersionIdRoute;
    const body = { analysisPrompt: 'New prompt' };
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
      vparams,
    );
    expect(res.status).toBe(200);
    expect(mocks.updateDraft).toHaveBeenCalledWith(admin.userId, ID, VID, body);
    expect((await res.json()).version.analysisPrompt).toBe('Describe the tone.');
  });

  it('passes dimensions to the service, which rejects them with details.field', async () => {
    mocks.updateDraft.mockRejectedValue(
      new AppError('validation_failed', undefined, { field: 'dimensions' }),
    );
    const { PATCH } = adminDefinitionsIdVersionsVersionIdRoute;
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ dimensions: [] }) }),
      vparams,
    );
    expect(res.status).toBe(422);
    expect(mocks.updateDraft).toHaveBeenCalledWith(admin.userId, ID, VID, { dimensions: [] });
    expect((await res.json()).error.details).toEqual({ field: 'dimensions' });
  });

  it('rejects a non-string analysisPrompt with 422', async () => {
    const { PATCH } = adminDefinitionsIdVersionsVersionIdRoute;
    const res = await PATCH(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ analysisPrompt: 5 }) }),
      vparams,
    );
    expect(res.status).toBe(422);
    expect(mocks.updateDraft).not.toHaveBeenCalled();
  });

  it('maps not_found and 403 on patch', async () => {
    const { PATCH } = adminDefinitionsIdVersionsVersionIdRoute;
    const req = () => new Request('http://x', { method: 'PATCH', body: '{}' });
    mocks.updateDraft.mockRejectedValue(new AppError('not_found'));
    expect((await PATCH(req(), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await PATCH(req(), vparams)).status).toBe(403);
  });

  it('discards a draft with 204', async () => {
    mocks.discardDraft.mockResolvedValue(undefined);
    const { DELETE } = adminDefinitionsIdVersionsVersionIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), vparams);
    expect(res.status).toBe(204);
    expect(mocks.discardDraft).toHaveBeenCalledWith(admin.userId, ID, VID);
  });

  it('delete maps not_found and 403', async () => {
    const { DELETE } = adminDefinitionsIdVersionsVersionIdRoute;
    mocks.discardDraft.mockRejectedValue(new AppError('not_found'));
    expect((await DELETE(new Request('http://x'), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await DELETE(new Request('http://x'), vparams)).status).toBe(403);
  });
});

describe('publish / diff / rollback / availability / history', () => {
  it('publishes a version', async () => {
    mocks.publish.mockResolvedValue(listItem);
    const { POST } = adminDefinitionsIdVersionsVersionIdPublishRoute;
    const res = await POST(post(), vparams);
    expect(res.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith(admin.userId, ID, VID);
    expect(await res.json()).toEqual({ definition: listItem });
  });

  it('publish returns 403 for non-admins and 404 when missing', async () => {
    const { POST } = adminDefinitionsIdVersionsVersionIdPublishRoute;
    mocks.publish.mockRejectedValue(new AppError('not_found'));
    expect((await POST(post(), vparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await POST(post(), vparams)).status).toBe(403);
  });

  it('diffs against another version and requires a uuid `against`', async () => {
    const result = {
      from: { id: OTHER, versionNumber: 1 },
      to: { id: VID, versionNumber: 2 },
      changes: [{ path: 'name', op: 'changed', before: 'a', after: 'b' }],
    };
    mocks.diff.mockResolvedValue(result);
    const { GET } = adminDefinitionsIdVersionsVersionIdDiffRoute;
    const ok = await GET(new Request(`http://x/d?against=${OTHER}`), vparams);
    expect(ok.status).toBe(200);
    expect(mocks.diff).toHaveBeenCalledWith(ID, VID, OTHER);
    expect(await ok.json()).toEqual(result);
    expect((await GET(new Request('http://x/d'), vparams)).status).toBe(422);
    expect((await GET(new Request('http://x/d?against=nope'), vparams)).status).toBe(422);
    expect(mocks.diff).toHaveBeenCalledTimes(1);
  });

  it('rolls back to a version', async () => {
    mocks.rollback.mockResolvedValue(listItem);
    const { POST } = adminDefinitionsIdRollbackRoute;
    const res = await POST(post({ versionId: VID }), params);
    expect(res.status).toBe(200);
    expect(mocks.rollback).toHaveBeenCalledWith(admin.userId, ID, VID);
    expect(await res.json()).toEqual({ definition: listItem });
  });

  it('rollback validates the body and maps not_found', async () => {
    const { POST } = adminDefinitionsIdRollbackRoute;
    expect((await POST(post({}), params)).status).toBe(422);
    expect((await POST(post({ versionId: 'x' }), params)).status).toBe(422);
    expect(mocks.rollback).not.toHaveBeenCalled();
    mocks.rollback.mockRejectedValue(new AppError('not_found'));
    expect((await POST(post({ versionId: VID }), params)).status).toBe(404);
  });

  it('sets availability and validates the value', async () => {
    mocks.setAvailability.mockResolvedValue({ ...listItem, availability: 'retired' });
    const { PUT } = adminDefinitionsIdAvailabilityRoute;
    const put = (body: unknown) =>
      new Request('http://x', { method: 'PUT', body: JSON.stringify(body) });
    const res = await PUT(put({ availability: 'retired' }), params);
    expect(res.status).toBe(200);
    expect(mocks.setAvailability).toHaveBeenCalledWith(admin.userId, ID, 'retired');
    expect((await res.json()).definition.availability).toBe('retired');
    expect((await PUT(put({ availability: 'gone' }), params)).status).toBe(422);
    expect(mocks.setAvailability).toHaveBeenCalledTimes(1);
  });

  it('availability returns 403 for non-admins', async () => {
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    const { PUT } = adminDefinitionsIdAvailabilityRoute;
    const res = await PUT(
      new Request('http://x', { method: 'PUT', body: JSON.stringify({ availability: 'retired' }) }),
      params,
    );
    expect(res.status).toBe(403);
    expect(mocks.setAvailability).not.toHaveBeenCalled();
  });

  it('returns history entries', async () => {
    const entries = [
      {
        action: 'publish',
        fromVersion: null,
        toVersion: { id: VID, versionNumber: 1 },
        actor: { id: admin.userId, name: 'Admin' },
        occurredAt: created,
      },
    ];
    mocks.history.mockResolvedValue(entries);
    const { GET } = adminDefinitionsIdHistoryRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(mocks.history).toHaveBeenCalledWith(ID);
    expect((await res.json())[0].occurredAt).toBe(created.toISOString());
  });

  it('history returns 404 and 403', async () => {
    const { GET } = adminDefinitionsIdHistoryRoute;
    mocks.history.mockRejectedValue(new AppError('not_found'));
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await GET(new Request('http://x'), params)).status).toBe(403);
  });
});

describe('preview (FR-004)', () => {
  const JOB = 'preview-44444444-4444-4444-8444-444444444444';
  const jparams = { params: Promise.resolve({ id: ID, versionId: VID, jobId: JOB }) };

  it('renders the generate preview by default', async () => {
    mocks.adminGetVersion.mockResolvedValue(version);
    mocks.previewDefinitionVersion.mockResolvedValue({ system: 'S', user: 'U' });
    const { POST } = adminDefinitionsIdVersionsVersionIdPreviewRoute;
    const res = await POST(post(), vparams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ system: 'S', user: 'U' });
    expect(mocks.rateLimit).toHaveBeenCalledWith(`admin-preview:${admin.userId}`, 60, 60);
    expect(mocks.adminGetVersion).toHaveBeenCalledWith(ID, VID);
    expect(mocks.previewDefinitionVersion).toHaveBeenCalledWith(VID, undefined);
  });

  it('renders the feedback preview and validates kind', async () => {
    mocks.adminGetVersion.mockResolvedValue(version);
    mocks.previewDefinitionVersion.mockResolvedValue({ system: 'S', user: 'U' });
    const { POST } = adminDefinitionsIdVersionsVersionIdPreviewRoute;
    expect((await POST(post({ kind: 'feedback' }), vparams)).status).toBe(200);
    expect(mocks.previewDefinitionVersion).toHaveBeenCalledWith(VID, 'feedback');
    expect((await POST(post({ kind: 'other' }), vparams)).status).toBe(422);
    expect(mocks.previewDefinitionVersion).toHaveBeenCalledTimes(1);
  });

  it('preview maps 404, 429 and 403', async () => {
    const { POST } = adminDefinitionsIdVersionsVersionIdPreviewRoute;
    mocks.adminGetVersion.mockRejectedValueOnce(new AppError('not_found'));
    expect((await POST(post(), vparams)).status).toBe(404);
    expect(mocks.previewDefinitionVersion).not.toHaveBeenCalled();
    mocks.rateLimit.mockRejectedValueOnce(new AppError('rate_limited'));
    expect((await POST(post(), vparams)).status).toBe(429);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await POST(post(), vparams)).status).toBe(403);
    expect(mocks.adminGetVersion).toHaveBeenCalledTimes(1);
  });

  it('starts a preview run with 202', async () => {
    mocks.startPreviewRun.mockResolvedValue({ jobId: JOB });
    const { POST } = adminDefinitionsIdVersionsVersionIdPreviewRunRoute;
    const res = await POST(post(), vparams);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: JOB });
    expect(mocks.rateLimit).toHaveBeenCalledWith(`admin-preview-run:${admin.userId}`, 10, 3600);
    expect(mocks.startPreviewRun).toHaveBeenCalledWith(admin.userId, ID, VID);
  });

  it('preview-run maps 404, 429 and 403', async () => {
    const { POST } = adminDefinitionsIdVersionsVersionIdPreviewRunRoute;
    mocks.startPreviewRun.mockRejectedValueOnce(new AppError('not_found'));
    expect((await POST(post(), vparams)).status).toBe(404);
    mocks.rateLimit.mockRejectedValueOnce(new AppError('rate_limited'));
    expect((await POST(post(), vparams)).status).toBe(429);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await POST(post(), vparams)).status).toBe(403);
    expect(mocks.startPreviewRun).toHaveBeenCalledTimes(1);
  });

  it('returns the preview-run status', async () => {
    const result = { status: 'done', markdown: '# Tone', problems: ['aspect_missing:tone'] };
    mocks.getPreviewRun.mockResolvedValue(result);
    const { GET } = adminDefinitionsIdVersionsVersionIdPreviewRunJobIdRoute;
    const res = await GET(new Request('http://x'), jparams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mocks.getPreviewRun).toHaveBeenCalledWith(ID, VID, JOB);
  });

  it('preview-run status fails closed on undeclared fields', async () => {
    mocks.getPreviewRun.mockResolvedValue({
      status: 'done',
      markdown: '# Tone',
      problems: [],
      body: 'leak',
    });
    const { GET } = adminDefinitionsIdVersionsVersionIdPreviewRunJobIdRoute;
    const res = await GET(new Request('http://x'), jparams);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('leak');
  });

  it('preview-run status maps 404 and 403', async () => {
    const { GET } = adminDefinitionsIdVersionsVersionIdPreviewRunJobIdRoute;
    mocks.getPreviewRun.mockRejectedValue(new AppError('not_found'));
    expect((await GET(new Request('http://x'), jparams)).status).toBe(404);
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    expect((await GET(new Request('http://x'), jparams)).status).toBe(403);
    expect(mocks.getPreviewRun).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as profilesIdVersionsRoute from '../app/api/profiles/[id]/versions/route';
import * as profilesIdVersionsVersionIdRoute from '../app/api/profiles/[id]/versions/[versionId]/route';
import * as profilesIdVersionsVersionIdRatingRoute from '../app/api/profiles/[id]/versions/[versionId]/rating/route';
import * as profilesIdRegenerateRoute from '../app/api/profiles/[id]/regenerate/route';
import * as profilesIdFeedbackRoute from '../app/api/profiles/[id]/feedback/route';
import * as profilesIdAdjustRoute from '../app/api/profiles/[id]/adjust/route';
import * as profilesIdDocumentRoute from '../app/api/profiles/[id]/document/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  versions: vi.fn(),
  version: vi.fn(),
  rate: vi.fn(),
  regenerate: vi.fn(),
  feedback: vi.fn(),
  adjust: vi.fn(),
  editDocument: vi.fn(),
}));

vi.mock('../lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('../lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/profiles', () => ({
  FEEDBACK_MAX_CHARS: 2000,
  NOTE_MAX_CHARS: 2000,
  versions: mocks.versions,
  version: mocks.version,
  rate: mocks.rate,
  regenerate: mocks.regenerate,
  feedback: mocks.feedback,
  adjust: mocks.adjust,
  editDocument: mocks.editDocument,
}));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const VALIDATION = 422;
const VID = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: ID }) };
const vparams = { params: Promise.resolve({ id: ID, versionId: VID }) };
const json = (method: string, body: unknown) =>
  new Request('http://x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('profile routes B', () => {
  it('lists versions', async () => {
    mocks.versions.mockResolvedValue([{ id: VID }]);
    const { GET } = profilesIdVersionsRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: VID }] });
  });

  it('audits a foreign profile on versions', async () => {
    mocks.versions.mockRejectedValue(new AppError('not_found'));
    const { GET } = profilesIdVersionsRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'profile', ID);
  });

  it('gets a version and audits 404', async () => {
    const { GET } = profilesIdVersionsVersionIdRoute;
    mocks.version.mockResolvedValue({ id: VID });
    expect((await GET(new Request('http://x'), vparams)).status).toBe(200);
    mocks.version.mockRejectedValue(new AppError('not_found'));
    expect((await GET(new Request('http://x'), vparams)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'profile', ID);
  });

  it('rates a version and rejects a bad rating', async () => {
    const { PUT } = profilesIdVersionsVersionIdRatingRoute;
    mocks.rate.mockResolvedValue({ profileVersion: { id: VID } });
    const ok = await PUT(json('PUT', { rating: 'sounds_like_me' }), vparams);
    expect(ok.status).toBe(200);
    expect(mocks.rate).toHaveBeenCalledWith(user, ID, VID, 'sounds_like_me');
    expect((await PUT(json('PUT', { rating: 'meh' }), vparams)).status).toBe(VALIDATION);
  });

  it('regenerate returns 202 and rate limits', async () => {
    mocks.regenerate.mockResolvedValue({ generationId: 'g1' });
    const { POST } = profilesIdRegenerateRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ generationId: 'g1' });
    expect(mocks.rateLimit).toHaveBeenCalledWith('profile-gen:u1', 10, 3600);
  });

  it('feedback returns 202 and validates length', async () => {
    mocks.feedback.mockResolvedValue({ generationId: 'g2' });
    const { POST } = profilesIdFeedbackRoute;
    const res = await POST(json('POST', { feedback: 'more casual' }), params);
    expect(res.status).toBe(202);
    expect(mocks.feedback).toHaveBeenCalledWith(user, ID, 'more casual');
    expect((await POST(json('POST', { feedback: '' }), params)).status).toBe(VALIDATION);
    expect((await POST(json('POST', { feedback: 'x'.repeat(2001) }), params)).status).toBe(
      VALIDATION,
    );
  });

  it('adjust returns 201', async () => {
    mocks.adjust.mockResolvedValue({ version: { id: VID } });
    const { POST } = profilesIdAdjustRoute;
    const body = { dimensions: { warmth: 4, tags: ['a'] }, note: 'n' };
    const res = await POST(json('POST', body), params);
    expect(res.status).toBe(201);
    expect(mocks.adjust).toHaveBeenCalledWith(user, ID, body);
  });

  it('adjust maps sensitive_content to 422', async () => {
    mocks.adjust.mockRejectedValue(new AppError('sensitive_content'));
    const { POST } = profilesIdAdjustRoute;
    const res = await POST(json('POST', { dimensions: { a: 'x' } }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('sensitive_content');
  });

  it('adjust audits foreign profile and rejects bad body', async () => {
    mocks.adjust.mockRejectedValue(new AppError('not_found'));
    const { POST } = profilesIdAdjustRoute;
    expect((await POST(json('POST', { dimensions: {} }), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'profile', ID);
    expect((await POST(json('POST', { dimensions: { a: {} } }), params)).status).toBe(VALIDATION);
  });

  it('adjust maps a conflict on a document to 409', async () => {
    mocks.adjust.mockRejectedValue(new AppError('conflict'));
    const { POST } = profilesIdAdjustRoute;
    const res = await POST(json('POST', { dimensions: { a: 'x' } }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conflict');
  });

  it('passes the union version view through', async () => {
    const view = { id: VID, format: 'document', promptSource: 'own', excerptSources: {} };
    mocks.version.mockResolvedValue(view);
    const res = await profilesIdVersionsVersionIdRoute.GET(new Request('http://x'), vparams);
    expect(await res.json()).toEqual(view);
  });
});

describe('document edit route', () => {
  const body = {
    baseVersionId: VID,
    summary: 's',
    sections: [{ heading: 'h', markdown: 'm' }],
    doList: ['a'],
    dontList: ['b'],
    keepExcerpts: [0, 2],
  };
  const { POST } = profilesIdDocumentRoute;

  it('returns 201 and passes the body to the service', async () => {
    const out = { version: { id: VID, versionNumber: 3, origin: 'manual_edit', createdAt: 'x' } };
    mocks.editDocument.mockResolvedValue(out);
    const res = await POST(json('POST', body), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(out);
    expect(mocks.editDocument).toHaveBeenCalledWith(user, ID, body);
  });

  it('rejects a malformed body with 422', async () => {
    expect((await POST(json('POST', { ...body, baseVersionId: 'nope' }), params)).status).toBe(
      VALIDATION,
    );
    expect((await POST(json('POST', { ...body, keepExcerpts: [1.5] }), params)).status).toBe(
      VALIDATION,
    );
    expect(mocks.editDocument).not.toHaveBeenCalled();
  });

  it('audits a foreign profile on 404', async () => {
    mocks.editDocument.mockRejectedValue(new AppError('not_found'));
    expect((await POST(json('POST', body), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'profile', ID);
  });

  it('maps conflict, validation_failed and sensitive_content', async () => {
    mocks.editDocument.mockRejectedValueOnce(new AppError('conflict'));
    expect((await POST(json('POST', body), params)).status).toBe(409);
    mocks.editDocument.mockRejectedValueOnce(
      new AppError('validation_failed', 'bad', { field: 'summary' }),
    );
    const v = await POST(json('POST', body), params);
    expect(v.status).toBe(VALIDATION);
    expect((await v.json()).error.details).toEqual({ field: 'summary' });
    mocks.editDocument.mockRejectedValueOnce(
      new AppError('sensitive_content', 'x', { fields: ['summary'] }),
    );
    const s = await POST(json('POST', body), params);
    expect(s.status).toBe(422);
    expect((await s.json()).error.details).toEqual({ fields: ['summary'] });
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });
});

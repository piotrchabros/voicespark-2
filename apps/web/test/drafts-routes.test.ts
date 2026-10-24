import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as draftsRoute from '../app/api/drafts/route';
import * as draftsIdRoute from '../app/api/drafts/[id]/route';
import * as draftsIdRegenerateRoute from '../app/api/drafts/[id]/regenerate/route';
import * as draftsIdRatingRoute from '../app/api/drafts/[id]/rating/route';
import * as draftsIdExportRoute from '../app/api/drafts/[id]/export/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  edit: vi.fn(),
  regenerate: vi.fn(),
  rate: vi.fn(),
  exportDraft: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('../lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/drafts', () => ({
  BRIEF_MAX: 2000,
  FEEDBACK_MAX: 2000,
  EDITED_TEXT_MAX: 20000,
  HUB_RECORD_KINDS: ['person', 'company', 'project'],
  create: mocks.create,
  list: mocks.list,
  get: mocks.get,
  edit: mocks.edit,
  regenerate: mocks.regenerate,
  rate: mocks.rate,
  exportDraft: mocks.exportDraft,
  remove: mocks.remove,
}));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const PID = '33333333-3333-4333-8333-333333333333';
const RID = '44444444-4444-4444-8444-444444444444';
const VALIDATION = 422;
const params = { params: Promise.resolve({ id: ID }) };

const json = (method: string, body?: unknown) =>
  new Request('http://localhost/api/drafts', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/drafts', () => {
  it('parses filters and pagination and returns the envelope', async () => {
    mocks.list.mockResolvedValue({ items: [{ id: ID }], nextCursor: 'next' });
    const { GET } = draftsRoute;
    const res = await GET(
      new Request(`http://x/api/drafts?contentType=bio&profileId=${PID}&cursor=c&limit=5`),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: ID }], nextCursor: 'next' });
    expect(mocks.list).toHaveBeenCalledWith(user, {
      contentType: 'bio',
      profileId: PID,
      cursor: 'c',
      limit: 5,
    });
  });

  it('returns items with hubRecord and hubContextStatus as the service gives them', async () => {
    const items = [
      { id: ID, hubRecord: { kind: 'person', id: null, label: 'Ewa' }, hubContextStatus: 'missing' },
      { id: PID, hubRecord: null, hubContextStatus: null },
    ];
    mocks.list.mockResolvedValue({ items, nextCursor: null });
    const { GET } = draftsRoute;
    const res = await GET(new Request('http://x/api/drafts'), undefined);
    expect(await res.json()).toEqual({ items, nextCursor: null });
  });

  it('rejects an unknown content type with 422', async () => {
    const { GET } = draftsRoute;
    const res = await GET(new Request('http://x/api/drafts?contentType=tweet'), undefined);
    expect(res.status).toBe(VALIDATION);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('POST /api/drafts', () => {
  it('returns 202 {draftId} and rate limits per user', async () => {
    mocks.create.mockResolvedValue({ draftId: ID });
    const { POST } = draftsRoute;
    const res = await POST(
      json('POST', { contentType: 'social_post', profileId: PID, brief: 'Launch post' }),
      undefined,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ draftId: ID });
    expect(mocks.rateLimit).toHaveBeenCalledWith('drafts:u1', 20, 60);
    expect(mocks.create).toHaveBeenCalledWith(user, {
      contentType: 'social_post',
      profileId: PID,
      brief: 'Launch post',
    });
  });

  it.each([
    ['empty brief', { contentType: 'bio', profileId: PID, brief: '' }],
    ['over-long brief', { contentType: 'bio', profileId: PID, brief: 'x'.repeat(2001) }],
    ['bad content type', { contentType: 'tweet', profileId: PID, brief: 'hi' }],
    ['bad profile id', { contentType: 'bio', profileId: 'nope', brief: 'hi' }],
  ])('rejects %s with 422', async (_name, body) => {
    const { POST } = draftsRoute;
    const res = await POST(json('POST', body), undefined);
    expect(res.status).toBe(VALIDATION);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('passes an optional hubRecord {kind, id} to the service (FR-027)', async () => {
    mocks.create.mockResolvedValue({ draftId: ID });
    const { POST } = draftsRoute;
    const hubRecord = { kind: 'person', id: RID };
    const res = await POST(
      json('POST', { contentType: 'bio', profileId: PID, brief: 'hi', hubRecord }),
      undefined,
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ draftId: ID });
    expect(mocks.create).toHaveBeenCalledWith(user, {
      contentType: 'bio',
      profileId: PID,
      brief: 'hi',
      hubRecord,
    });
  });

  it.each([
    ['unknown kind', { kind: 'thread', id: RID }],
    ['bad id', { kind: 'company', id: 'nope' }],
    ['missing id', { kind: 'project' }],
    ['not an object', 'person'],
  ])('rejects a hubRecord with %s with 422', async (_name, hubRecord) => {
    const { POST } = draftsRoute;
    const res = await POST(
      json('POST', { contentType: 'bio', profileId: PID, brief: 'hi', hubRecord }),
      undefined,
    );
    expect(res.status).toBe(VALIDATION);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps another user's record to 404 not_found", async () => {
    mocks.create.mockRejectedValue(new AppError('not_found', undefined, undefined, 404));
    const { POST } = draftsRoute;
    const res = await POST(
      json('POST', {
        contentType: 'bio',
        profileId: PID,
        brief: 'hi',
        hubRecord: { kind: 'company', id: RID },
      }),
      undefined,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('maps no_profile to 409', async () => {
    mocks.create.mockRejectedValue(new AppError('no_profile'));
    const { POST } = draftsRoute;
    const res = await POST(
      json('POST', { contentType: 'bio', profileId: PID, brief: 'hi' }),
      undefined,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('no_profile');
  });

  it('stops at the rate limit', async () => {
    mocks.rateLimit.mockRejectedValue(new AppError('rate_limited'));
    const { POST } = draftsRoute;
    const res = await POST(
      json('POST', { contentType: 'bio', profileId: PID, brief: 'hi' }),
      undefined,
    );
    expect(res.status).toBe(429);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('/api/drafts/[id]', () => {
  it('GET returns the draft view', async () => {
    mocks.get.mockResolvedValue({ id: ID, text: 'hello' });
    const { GET } = draftsIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, text: 'hello' });
    expect(mocks.get).toHaveBeenCalledWith(user, ID);
  });

  it('GET carries hubRecord and hubContextStatus', async () => {
    const view = {
      id: ID,
      hubRecord: { kind: 'company', id: RID, label: 'Acme' },
      hubContextStatus: 'used',
    };
    mocks.get.mockResolvedValue(view);
    const { GET } = draftsIdRoute;
    expect(await (await GET(new Request('http://x'), params)).json()).toEqual(view);
  });

  it('GET audits a foreign access and returns 404', async () => {
    mocks.get.mockRejectedValue(new AppError('not_found'));
    const { GET } = draftsIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'draft', ID);
  });

  it('PATCH edits and returns {draft}', async () => {
    mocks.edit.mockResolvedValue({ id: ID, editedText: 'new' });
    const { PATCH } = draftsIdRoute;
    const res = await PATCH(json('PATCH', { editedText: 'new' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draft: { id: ID, editedText: 'new' } });
    expect(mocks.edit).toHaveBeenCalledWith(user, ID, 'new');
  });

  it('PATCH rejects a missing or over-long editedText with 422', async () => {
    const { PATCH } = draftsIdRoute;
    expect((await PATCH(json('PATCH', {}), params)).status).toBe(VALIDATION);
    expect((await PATCH(json('PATCH', { editedText: 'x'.repeat(20001) }), params)).status).toBe(
      VALIDATION,
    );
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it('PATCH maps a not-ready draft to 409', async () => {
    mocks.edit.mockRejectedValue(new AppError('conflict'));
    const { PATCH } = draftsIdRoute;
    const res = await PATCH(json('PATCH', { editedText: 'new' }), params);
    expect(res.status).toBe(409);
  });

  it('PATCH audits a foreign access', async () => {
    mocks.edit.mockRejectedValue(new AppError('not_found'));
    const { PATCH } = draftsIdRoute;
    const res = await PATCH(json('PATCH', { editedText: 'new' }), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'draft', ID);
  });

  it('DELETE returns 204', async () => {
    mocks.remove.mockResolvedValue(undefined);
    const { DELETE } = draftsIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith(user, ID);
  });

  it('DELETE audits a foreign access', async () => {
    mocks.remove.mockRejectedValue(new AppError('not_found'));
    const { DELETE } = draftsIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'draft', ID);
  });
});

describe('POST /api/drafts/[id]/regenerate', () => {
  it('returns 202 {draftId}, passes feedback and rate limits', async () => {
    mocks.regenerate.mockResolvedValue({ draftId: 'new' });
    const { POST } = draftsIdRegenerateRoute;
    const res = await POST(json('POST', { feedback: 'shorter' }), params);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ draftId: 'new' });
    expect(mocks.rateLimit).toHaveBeenCalledWith('drafts:u1', 20, 60);
    expect(mocks.regenerate).toHaveBeenCalledWith(user, ID, 'shorter');
  });

  it('accepts an empty body (feedback is optional)', async () => {
    mocks.regenerate.mockResolvedValue({ draftId: 'new' });
    const { POST } = draftsIdRegenerateRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(202);
    expect(mocks.regenerate).toHaveBeenCalledWith(user, ID, undefined);
  });

  it('rejects over-long feedback with 422', async () => {
    const { POST } = draftsIdRegenerateRoute;
    const res = await POST(json('POST', { feedback: 'x'.repeat(2001) }), params);
    expect(res.status).toBe(VALIDATION);
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('maps no_profile to 409 and audits a foreign access', async () => {
    const { POST } = draftsIdRegenerateRoute;
    mocks.regenerate.mockRejectedValueOnce(new AppError('no_profile'));
    expect((await POST(json('POST', {}), params)).status).toBe(409);
    mocks.regenerate.mockRejectedValueOnce(new AppError('not_found'));
    expect((await POST(json('POST', {}), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'draft', ID);
  });
});

describe('PUT /api/drafts/[id]/rating', () => {
  it('rates and returns {draft}', async () => {
    mocks.rate.mockResolvedValue({ id: ID, rating: 'not_like_me' });
    const { PUT } = draftsIdRatingRoute;
    const res = await PUT(json('PUT', { rating: 'not_like_me' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draft: { id: ID, rating: 'not_like_me' } });
    expect(mocks.rate).toHaveBeenCalledWith(user, ID, 'not_like_me');
  });

  it('rejects an unknown rating with 422', async () => {
    const { PUT } = draftsIdRatingRoute;
    const res = await PUT(json('PUT', { rating: 'love_it' }), params);
    expect(res.status).toBe(VALIDATION);
    expect(mocks.rate).not.toHaveBeenCalled();
  });

  it('audits a foreign access', async () => {
    mocks.rate.mockRejectedValue(new AppError('not_found'));
    const { PUT } = draftsIdRatingRoute;
    const res = await PUT(json('PUT', { rating: 'sounds_like_me' }), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'draft', ID);
  });
});

describe('GET /api/drafts/[id]/export', () => {
  it('returns a markdown attachment', async () => {
    mocks.exportDraft.mockResolvedValue({
      filename: 'draft-2026-01-01-bio.md',
      contentType: 'text/markdown',
      body: '# T\n\nbody\n',
    });
    const { GET } = draftsIdExportRoute;
    const res = await GET(new Request('http://x/api/drafts/' + ID + '/export?format=md'), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="draft-2026-01-01-bio.md"',
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('# T\n\nbody\n');
    expect(mocks.exportDraft).toHaveBeenCalledWith(user, ID, 'md');
  });

  it('returns a plain-text attachment for txt', async () => {
    mocks.exportDraft.mockResolvedValue({
      filename: 'draft-2026-01-01-bio.txt',
      contentType: 'text/plain',
      body: 'body\n',
    });
    const { GET } = draftsIdExportRoute;
    const res = await GET(new Request('http://x/api/drafts/' + ID + '/export?format=txt'), params);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('attachment;');
    expect(mocks.exportDraft).toHaveBeenCalledWith(user, ID, 'txt');
  });

  it.each(['pdf', ''])('rejects format %j with 422', async (format) => {
    const { GET } = draftsIdExportRoute;
    const res = await GET(
      new Request('http://x/api/drafts/' + ID + '/export?format=' + format),
      params,
    );
    expect(res.status).toBe(VALIDATION);
    expect(mocks.exportDraft).not.toHaveBeenCalled();
  });

  it('audits a foreign access', async () => {
    mocks.exportDraft.mockRejectedValue(new AppError('not_found'));
    const { GET } = draftsIdExportRoute;
    const res = await GET(new Request('http://x/api/drafts/' + ID + '/export?format=md'), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'draft', ID);
  });
});

describe('no publish surface (FR-056)', () => {
  const root = join(fileURLToPath(new URL('../', import.meta.url)), 'app', 'api', 'drafts');
  const routeFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? routeFiles(join(dir, e.name))
        : e.name === 'route.ts'
          ? [join(dir, e.name)]
          : [],
    );

  it('ships the draft routes but no publish route', () => {
    for (const rel of [
      'route.ts',
      '[id]/route.ts',
      '[id]/regenerate/route.ts',
      '[id]/rating/route.ts',
      '[id]/export/route.ts',
    ]) {
      expect(existsSync(join(root, rel)), rel).toBe(true);
    }
    expect(existsSync(join(root, '[id]', 'publish'))).toBe(false);
    for (const file of routeFiles(root)) {
      expect(file).not.toMatch(/publish/i);
      expect(readFileSync(file, 'utf8')).not.toMatch(
        /export\s+(const|async function|function)\s+\w*publish/i,
      );
    }
  });
});

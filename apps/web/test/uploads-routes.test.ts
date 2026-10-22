import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as uploadsRoute from '../app/api/uploads/route';
import * as notesRoute from '../app/api/notes/route';
import * as uploadsIdRoute from '../app/api/uploads/[id]/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireFiltersConfirmed: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  createFileUpload: vi.fn(),
  createNote: vi.fn(),
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  requireFiltersConfirmed: mocks.requireFiltersConfirmed,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/uploads', () => ({
  NOTE_MAX_CHARS: 100_000,
  NOTE_TITLE_MAX: 200,
  list: mocks.list,
  get: mocks.get,
  remove: mocks.remove,
  createFileUpload: mocks.createFileUpload,
  createNote: mocks.createNote,
}));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };
const noParams = { params: Promise.resolve({}) };

function fileForm(extra?: Record<string, string>, withFile = true): Request {
  const form = new FormData();
  if (withFile) form.set('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
  for (const [k, v] of Object.entries(extra ?? {})) form.set(k, v);
  return new Request('http://x/api/uploads', { method: 'POST', body: form });
}

function json(body: unknown): Request {
  return new Request('http://x/api/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('POST /api/uploads', () => {
  it('returns 202 with the upload id and rate limits per user', async () => {
    mocks.createFileUpload.mockResolvedValue({ uploadId: ID });
    const { POST } = uploadsRoute;
    const res = await POST(fileForm({ authorship: 'received' }), noParams);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ uploadId: ID });
    expect(mocks.rateLimit).toHaveBeenCalledWith('uploads:u1', 60, 3600);
    const arg = mocks.createFileUpload.mock.calls[0]?.[1];
    expect(arg.filename).toBe('a.txt');
    expect(arg.authorship).toBe('received');
    expect(Buffer.isBuffer(arg.buffer)).toBe(true);
  });

  it('rejects a missing file and a bad authorship with 400', async () => {
    const { POST } = uploadsRoute;
    expect((await POST(fileForm({}, false), noParams)).status).toBe(422);
    expect((await POST(fileForm({ authorship: 'bogus' }), noParams)).status).toBe(422);
    expect(mocks.createFileUpload).not.toHaveBeenCalled();
  });

  it('maps unsupported_type to 415 and too_large to 413', async () => {
    const { POST } = uploadsRoute;
    mocks.createFileUpload.mockRejectedValueOnce(new AppError('unsupported_type'));
    expect((await POST(fileForm(), noParams)).status).toBe(415);
    mocks.createFileUpload.mockRejectedValueOnce(new AppError('too_large'));
    expect((await POST(fileForm(), noParams)).status).toBe(413);
  });

  it('requires confirmed filters', async () => {
    mocks.requireFiltersConfirmed.mockRejectedValue(new AppError('filter_confirmation_required'));
    const { POST } = uploadsRoute;
    const res = await POST(fileForm(), noParams);
    expect(res.status).toBe(409);
    expect(mocks.createFileUpload).not.toHaveBeenCalled();
  });
});

describe('GET /api/uploads', () => {
  it('passes pagination to the service', async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    const { GET } = uploadsRoute;
    const res = await GET(new Request('http://x/api/uploads?limit=5&cursor=abc'), noParams);
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(user, { cursor: 'abc', limit: 5 });
  });
});

describe('POST /api/notes', () => {
  it('returns 202 for a valid note', async () => {
    mocks.createNote.mockResolvedValue({ uploadId: ID });
    const { POST } = notesRoute;
    const res = await POST(json({ text: 'hi', title: 't' }), noParams);
    expect(res.status).toBe(202);
    expect(mocks.rateLimit).toHaveBeenCalledWith('uploads:u1', 60, 3600);
  });

  it('rejects empty text and an overlong title', async () => {
    const { POST } = notesRoute;
    expect((await POST(json({ text: '' }), noParams)).status).toBe(422);
    expect((await POST(json({ text: 'x', title: 'y'.repeat(201) }), noParams)).status).toBe(422);
  });
});

describe('/api/uploads/[id]', () => {
  it('GET returns the view', async () => {
    mocks.get.mockResolvedValue({ id: ID });
    const { GET } = uploadsIdRoute;
    expect(await (await GET(new Request('http://x'), params)).json()).toEqual({ id: ID });
  });

  it('GET audits and returns 404 for a foreign id', async () => {
    mocks.get.mockRejectedValue(new AppError('not_found'));
    const { GET } = uploadsIdRoute;
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'upload', ID);
  });

  it('DELETE returns 202 with the deletion request id', async () => {
    mocks.remove.mockResolvedValue({ deletionRequestId: 'd1' });
    const { DELETE } = uploadsIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deletionRequestId: 'd1' });
  });

  it('DELETE audits a 404', async () => {
    mocks.remove.mockRejectedValue(new AppError('not_found'));
    const { DELETE } = uploadsIdRoute;
    expect((await DELETE(new Request('http://x', { method: 'DELETE' }), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'upload', ID);
  });
});

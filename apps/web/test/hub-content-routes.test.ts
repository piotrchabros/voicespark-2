import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as linksRoute from '../app/api/hub/links/route';
import * as linkIdRoute from '../app/api/hub/links/[id]/route';
import * as recordNotesRoute from '../app/api/hub/[kind]/[id]/notes/route';
import * as noteIdRoute from '../app/api/hub/notes/[id]/route';
import * as recordFilesRoute from '../app/api/hub/[kind]/[id]/files/route';
import * as fileIdRoute from '../app/api/hub/files/[id]/route';
import * as downloadRoute from '../app/api/hub/files/[id]/download/route';

const MAX = 26214400;

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  links: { create: vi.fn(), setRole: vi.fn(), remove: vi.fn() },
  notes: { list: vi.fn(), create: vi.fn(), get: vi.fn(), patch: vi.fn(), remove: vi.fn() },
  files: {
    upload: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    download: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/env', () => ({ loadEnv: () => ({ HUB_FILE_MAX_BYTES: MAX }) }));
vi.mock('@voicespark/core/services/hub/links', () => mocks.links);
vi.mock('@voicespark/core/services/hub/notes', () => mocks.notes);
vi.mock('@voicespark/core/services/hub/files', () => mocks.files);

const user = { userId: 'u1', role: 'user' as const };
const admin = { userId: 'a1', role: 'admin' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const noParams = { params: Promise.resolve({}) };
const idParams = (id = ID) => ({ params: Promise.resolve({ id }) });
const recordParams = (kind: string, id = ID) => ({ params: Promise.resolve({ kind, id }) });

function req(method: string, body?: unknown, url = 'http://x/api/hub'): Request {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

function multipart(
  parts: Record<string, string | File>,
  headers?: Record<string, string>,
): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) form.append(k, v);
  return new Request('http://x/api/hub/people/id/files', {
    method: 'POST',
    body: form,
    ...(headers ? { headers } : {}),
  });
}

const sync = { status: 'pending', lastSyncedAt: null };
const link = {
  id: ID,
  kind: 'person_company',
  personId: ID,
  companyId: OTHER,
  projectId: null,
  role: 'CTO',
  roleOwnerSet: true,
  origin: 'user',
};
const doc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
};
const note = {
  id: ID,
  owner: { kind: 'person', id: OTHER },
  title: 'Call notes',
  body: doc,
  redactedValues: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sync,
};
const file = {
  id: ID,
  ownerKind: 'company',
  ownerId: OTHER,
  name: 'offer.pdf',
  description: null,
  mimeType: 'application/pdf',
  extension: 'pdf',
  sizeBytes: 5,
  extractionStatus: 'pending',
  extractionReason: null,
  redactedValues: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sync,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('POST /api/hub/links', () => {
  it('creates a link and returns 201 {link}', async () => {
    mocks.links.create.mockResolvedValue({ link });
    const body = { kind: 'person_company', personId: ID, companyId: OTHER, role: 'CTO' };
    const res = await linksRoute.POST(req('POST', body), noParams);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ link });
    expect(mocks.links.create).toHaveBeenCalledWith(user, body);
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-links:u1', 120, 60);
  });

  it('maps link_exists and invalid_link to 409', async () => {
    mocks.links.create.mockRejectedValueOnce(
      new AppError('link_exists', undefined, { linkId: OTHER }),
    );
    const a = await linksRoute.POST(
      req('POST', { kind: 'person_company', personId: ID, companyId: OTHER }),
      noParams,
    );
    expect(a.status).toBe(409);
    expect(await errorCode(a)).toBe('link_exists');
    mocks.links.create.mockRejectedValueOnce(new AppError('invalid_link'));
    const b = await linksRoute.POST(
      req('POST', { kind: 'person_company', personId: ID, projectId: OTHER }),
      noParams,
    );
    expect(b.status).toBe(409);
    expect(await errorCode(b)).toBe('invalid_link');
  });

  it('returns 404 for a foreign record and audits both ends for an admin', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.links.create.mockRejectedValue(new AppError('not_found'));
    const res = await linksRoute.POST(
      req('POST', { kind: 'company_project', companyId: ID, projectId: OTHER }),
      noParams,
    );
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_company', ID);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_project', OTHER);
  });

  it('rejects a non-JSON body with 422', async () => {
    const res = await linksRoute.POST(
      new Request('http://x', { method: 'POST', body: 'nope' }),
      noParams,
    );
    expect(res.status).toBe(422);
    expect(mocks.links.create).not.toHaveBeenCalled();
  });
});

describe('PATCH|DELETE /api/hub/links/{id}', () => {
  it('sets and clears the role', async () => {
    mocks.links.setRole.mockResolvedValue({ link });
    const res = await linkIdRoute.PATCH(req('PATCH', { role: 'CTO' }), idParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link });
    expect(mocks.links.setRole).toHaveBeenCalledWith(user, ID, 'CTO');
    await linkIdRoute.PATCH(req('PATCH', { role: null }), idParams());
    expect(mocks.links.setRole).toHaveBeenLastCalledWith(user, ID, null);
  });

  it('deletes with 204', async () => {
    mocks.links.remove.mockResolvedValue(undefined);
    const res = await linkIdRoute.DELETE(req('DELETE'), idParams());
    expect(res.status).toBe(204);
    expect(mocks.links.remove).toHaveBeenCalledWith(user, ID);
  });

  it('returns 404 for another user and audits an admin', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.links.remove.mockRejectedValue(new AppError('not_found'));
    const res = await linkIdRoute.DELETE(req('DELETE'), idParams());
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_link', ID);
  });
});

describe('GET|POST /api/hub/{kind}/{id}/notes', () => {
  it('lists notes with cursor and limit', async () => {
    mocks.notes.list.mockResolvedValue({ items: [note], nextCursor: 'c2' });
    const res = await recordNotesRoute.GET(
      req('GET', undefined, 'http://x/api/hub/people/id/notes?cursor=c1&limit=10'),
      recordParams('people'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [note], nextCursor: 'c2' });
    expect(mocks.notes.list).toHaveBeenCalledWith(user, 'person', ID, { cursor: 'c1', limit: 10 });
  });

  it('creates a note and returns 201 {note}', async () => {
    mocks.notes.create.mockResolvedValue(note);
    const res = await recordNotesRoute.POST(
      req('POST', { title: 'Call notes', body: doc }),
      recordParams('companies'),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ note });
    expect(mocks.notes.create).toHaveBeenCalledWith(user, 'company', ID, {
      title: 'Call notes',
      body: doc,
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-notes:u1', 120, 60);
  });

  it('maps note_excluded to 422 and inspection_unavailable to 503', async () => {
    mocks.notes.create.mockRejectedValueOnce(
      new AppError('note_excluded', undefined, { category: 'health' }),
    );
    const a = await recordNotesRoute.POST(
      req('POST', { title: '', body: doc }),
      recordParams('people'),
    );
    expect(a.status).toBe(422);
    const json = (await a.json()) as { error: { code: string; details: { category: string } } };
    expect(json.error.code).toBe('note_excluded');
    expect(json.error.details.category).toBe('health');
    mocks.notes.create.mockRejectedValueOnce(new AppError('inspection_unavailable'));
    const b = await recordNotesRoute.POST(
      req('POST', { title: '', body: doc }),
      recordParams('people'),
    );
    expect(b.status).toBe(503);
    expect(await errorCode(b)).toBe('inspection_unavailable');
  });

  it('returns 404 for an unknown kind and audits a foreign record for an admin', async () => {
    const bad = await recordNotesRoute.GET(req('GET'), recordParams('notes'));
    expect(bad.status).toBe(404);
    expect(mocks.notes.list).not.toHaveBeenCalled();

    mocks.requireUser.mockResolvedValue(admin);
    mocks.notes.list.mockRejectedValue(new AppError('not_found'));
    const res = await recordNotesRoute.GET(req('GET'), recordParams('projects'));
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_project', ID);
  });
});

describe('GET|PATCH|DELETE /api/hub/notes/{id}', () => {
  it('gets, patches and deletes a note', async () => {
    mocks.notes.get.mockResolvedValue(note);
    const g = await noteIdRoute.GET(req('GET'), idParams());
    expect(g.status).toBe(200);
    expect(await g.json()).toEqual({ note });

    mocks.notes.patch.mockResolvedValue({ ...note, title: 'New' });
    const p = await noteIdRoute.PATCH(req('PATCH', { title: 'New' }), idParams());
    expect(p.status).toBe(200);
    expect(((await p.json()) as { note: { title: string } }).note.title).toBe('New');
    expect(mocks.notes.patch).toHaveBeenCalledWith(user, ID, { title: 'New' });
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-notes:u1', 120, 60);

    mocks.notes.remove.mockResolvedValue(undefined);
    const d = await noteIdRoute.DELETE(req('DELETE'), idParams());
    expect(d.status).toBe(204);
    expect(mocks.notes.remove).toHaveBeenCalledWith(user, ID);
  });

  it('returns 404 for another user and audits an admin', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.notes.get.mockRejectedValue(new AppError('not_found'));
    const res = await noteIdRoute.GET(req('GET'), idParams());
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_note', ID);
  });
});

describe('GET|POST /api/hub/{kind}/{id}/files', () => {
  it('lists the files of a record as {items}', async () => {
    mocks.files.list.mockResolvedValue([file]);
    const res = await recordFilesRoute.GET(req('GET'), recordParams('companies'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [file] });
    expect(mocks.files.list).toHaveBeenCalledWith(user, 'company', ID);
  });

  it('uploads a multipart file and returns 202 {file} with extractionStatus pending', async () => {
    mocks.files.upload.mockResolvedValue({ file, sync });
    const res = await recordFilesRoute.POST(
      multipart({
        file: new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'offer.pdf'),
        description: 'The offer',
      }),
      recordParams('companies'),
    );
    expect(res.status).toBe(202);
    const json = (await res.json()) as { file: { extractionStatus: string } };
    expect(json.file.extractionStatus).toBe('pending');
    const [ctx, kind, id, input] = mocks.files.upload.mock.calls[0]!;
    expect([ctx, kind, id]).toEqual([user, 'company', ID]);
    expect(input.filename).toBe('offer.pdf');
    expect(input.description).toBe('The offer');
    expect(Array.from(input.bytes as Uint8Array)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it('shares the 60/hour upload rate limit with uploads', async () => {
    mocks.files.upload.mockResolvedValue({ file, sync });
    await recordFilesRoute.POST(
      multipart({ file: new File(['hi'], 'a.txt') }),
      recordParams('people'),
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith('uploads:u1', 60, 3600);
  });

  it('rejects content-length over HUB_FILE_MAX_BYTES + 1 MB with 413 before parsing the body', async () => {
    const request = multipart(
      { file: new File(['hi'], 'a.txt') },
      { 'content-length': String(MAX + 1048576 + 1) },
    );
    const formData = vi.spyOn(request, 'formData');
    const res = await recordFilesRoute.POST(request, recordParams('people'));
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('too_large');
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.files.upload).not.toHaveBeenCalled();
  });

  it('maps too_large to 413 and unsupported_type to 415 with details.allowed', async () => {
    mocks.files.upload.mockRejectedValueOnce(new AppError('too_large'));
    const a = await recordFilesRoute.POST(
      multipart({ file: new File(['x'], 'big.pdf') }),
      recordParams('people'),
    );
    expect(a.status).toBe(413);
    expect(await errorCode(a)).toBe('too_large');

    mocks.files.upload.mockRejectedValueOnce(
      new AppError('unsupported_type', undefined, { allowed: ['pdf', 'docx'] }),
    );
    const b = await recordFilesRoute.POST(
      multipart({ file: new File(['<svg/>'], 'x.svg') }),
      recordParams('people'),
    );
    expect(b.status).toBe(415);
    const json = (await b.json()) as { error: { code: string; details: { allowed: string[] } } };
    expect(json.error.code).toBe('unsupported_type');
    expect(json.error.details.allowed).toEqual(['pdf', 'docx']);
  });

  it('requires a file part and multipart data', async () => {
    const a = await recordFilesRoute.POST(multipart({ description: 'x' }), recordParams('people'));
    expect(a.status).toBe(422);
    const b = await recordFilesRoute.POST(req('POST', { file: 'x' }), recordParams('people'));
    expect(b.status).toBe(422);
    expect(mocks.files.upload).not.toHaveBeenCalled();
  });

  it('returns 404 for a foreign record and audits an admin', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.files.upload.mockRejectedValue(new AppError('not_found'));
    const res = await recordFilesRoute.POST(
      multipart({ file: new File(['hi'], 'a.txt') }),
      recordParams('people'),
    );
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_person', ID);
  });
});

describe('GET|PATCH|DELETE /api/hub/files/{id}', () => {
  it('gets, renames and deletes a file', async () => {
    mocks.files.get.mockResolvedValue({ file, sync });
    const g = await fileIdRoute.GET(req('GET'), idParams());
    expect(g.status).toBe(200);
    expect(((await g.json()) as { file: unknown }).file).toEqual(file);

    mocks.files.patch.mockResolvedValue({ file: { ...file, name: 'new.pdf' }, sync });
    const p = await fileIdRoute.PATCH(
      req('PATCH', { name: 'new.pdf', description: null }),
      idParams(),
    );
    expect(p.status).toBe(200);
    expect(mocks.files.patch).toHaveBeenCalledWith(user, ID, {
      name: 'new.pdf',
      description: null,
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-files:u1', 120, 60);

    mocks.files.remove.mockResolvedValue(undefined);
    const d = await fileIdRoute.DELETE(req('DELETE'), idParams());
    expect(d.status).toBe(204);
    expect(mocks.files.remove).toHaveBeenCalledWith(user, ID);
  });

  it('rejects a name with a slash, backslash or control char, or outside 1..255, with 422', async () => {
    for (const name of ['a/b.pdf', 'a\\b.pdf', 'a\u0007.pdf', '', 'x'.repeat(256)]) {
      mocks.files.patch.mockRejectedValueOnce(
        new AppError('validation_failed', undefined, { fields: ['name'] }),
      );
      const res = await fileIdRoute.PATCH(req('PATCH', { name }), idParams());
      expect(res.status).toBe(422);
      expect(mocks.files.patch).toHaveBeenLastCalledWith(user, ID, { name });
    }
  });

  it('returns 404 for another user and audits an admin', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.files.patch.mockRejectedValue(new AppError('not_found'));
    const res = await fileIdRoute.PATCH(req('PATCH', { name: 'x.pdf' }), idParams());
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_file', ID);
  });
});

describe('GET /api/hub/files/{id}/download', () => {
  it('streams the original with attachment, nosniff and private no-store headers', async () => {
    mocks.files.download.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'oferta "ł".pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
    });
    const res = await downloadRoute.GET(req('GET'), idParams());
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd.startsWith('attachment;')).toBe(true);
    expect(cd).not.toContain('"ł"');
    expect(cd).toContain("filename*=UTF-8''");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(mocks.files.download).toHaveBeenCalledWith(user, ID);
  });

  it('strips header-breaking characters from the file name', async () => {
    mocks.files.download.mockResolvedValue({
      bytes: new Uint8Array([1]),
      filename: 'a\r\nSet-Cookie: x.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
    });
    const res = await downloadRoute.GET(req('GET'), idParams());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
  });

  it('returns 404 to another user (the audit helper skips non-admins)', async () => {
    mocks.files.download.mockRejectedValue(new AppError('not_found'));
    const res = await downloadRoute.GET(req('GET'), idParams());
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_file', ID);
  });

  it('returns 404 to an admin and records admin.content_access_denied', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.files.download.mockRejectedValue(new AppError('not_found'));
    const res = await downloadRoute.GET(req('GET'), idParams());
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_file', ID);
  });
});

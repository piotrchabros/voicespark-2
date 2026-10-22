import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  sources: { reconnect: vi.fn(), pause: vi.fn(), resume: vi.fn(), disconnect: vi.fn() },
  imports: { listForSource: vi.fn(), getForUser: vi.fn() },
}));

vi.mock('../../lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@voicespark/core/queues', () => ({ getRedisConnection: () => ({}) }));
vi.mock('@voicespark/core/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@voicespark/core/services/sources', () => mocks.sources);
vi.mock('@voicespark/core/services/imports', () => mocks.imports);

import { AppError } from '@voicespark/core/errors';
import { POST as reconnect } from '../../app/api/sources/[id]/reconnect/route';
import { POST as pause } from '../../app/api/sources/[id]/pause/route';
import { POST as resume } from '../../app/api/sources/[id]/resume/route';
import { POST as disconnect } from '../../app/api/sources/[id]/disconnect/route';
import { GET as listImports } from '../../app/api/sources/[id]/imports/route';
import { GET as getImport } from '../../app/api/imports/[id]/route';

const user = { userId: 'u1', role: 'user' as const };
const ctx = { params: Promise.resolve({ id: 'abc' }) };
const post = (body?: unknown) =>
  new Request('http://x/api', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('source action routes', () => {
  it('reconnect passes an empty body for OAuth and returns the authorize URL', async () => {
    mocks.sources.reconnect.mockResolvedValue({ authorizeUrl: 'https://auth' });
    const res = await reconnect(post(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorizeUrl: 'https://auth' });
    expect(mocks.sources.reconnect).toHaveBeenCalledWith(user, 'abc', {});
  });

  it('reconnect forwards the IMAP password', async () => {
    mocks.sources.reconnect.mockResolvedValue({ source: { id: 'abc' } });
    await reconnect(post({ password: 'pw' }), ctx);
    expect(mocks.sources.reconnect).toHaveBeenCalledWith(user, 'abc', { password: 'pw' });
  });

  it('pause and resume wrap the source', async () => {
    mocks.sources.pause.mockResolvedValue({ id: 'abc', status: 'paused' });
    mocks.sources.resume.mockResolvedValue({ id: 'abc', status: 'connected' });
    expect(await (await pause(post(), ctx)).json()).toEqual({
      source: { id: 'abc', status: 'paused' },
    });
    expect(await (await resume(post(), ctx)).json()).toEqual({
      source: { id: 'abc', status: 'connected' },
    });
  });

  it('disconnect validates the body and returns the deletion request id', async () => {
    const bad = await disconnect(post({}), ctx);
    expect(bad.status).toBe(422);
    mocks.sources.disconnect.mockResolvedValue({ source: { id: 'abc' }, deletionRequestId: 'd1' });
    const res = await disconnect(post({ deleteContent: true }), ctx);
    expect(await res.json()).toEqual({ source: { id: 'abc' }, deletionRequestId: 'd1' });
    expect(mocks.sources.disconnect).toHaveBeenCalledWith(user, 'abc', true);
  });

  it('audits and returns 404 for a foreign source', async () => {
    mocks.sources.pause.mockRejectedValue(new AppError('not_found'));
    const res = await pause(post(), ctx);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'source', 'abc');
  });

  it('does not audit non-404 errors', async () => {
    mocks.sources.resume.mockRejectedValue(new AppError('conflict'));
    expect((await resume(post(), ctx)).status).toBe(409);
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });
});

describe('import routes', () => {
  it('lists imports for a source and audits 404', async () => {
    mocks.imports.listForSource.mockResolvedValue([{ id: 'j1' }]);
    expect(await (await listImports(new Request('http://x'), ctx)).json()).toEqual([{ id: 'j1' }]);
    mocks.imports.listForSource.mockRejectedValue(new AppError('not_found'));
    expect((await listImports(new Request('http://x'), ctx)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'source', 'abc');
  });

  it('gets an import and audits import_job on 404', async () => {
    mocks.imports.getForUser.mockRejectedValue(new AppError('not_found'));
    expect((await getImport(new Request('http://x'), ctx)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'import_job', 'abc');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as sourcesIdRoute from '../app/api/sources/[id]/route';
import * as contentItemsIdRoute from '../app/api/content-items/[id]/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  sourcesGet: vi.fn(),
  sourcesRemove: vi.fn(),
  itemsRemove: vi.fn(),
}));

vi.mock('../lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@voicespark/core/services/sources', () => ({
  get: mocks.sourcesGet,
  remove: mocks.sourcesRemove,
}));
vi.mock('@voicespark/core/services/content-items', () => ({
  remove: mocks.itemsRemove,
}));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('DELETE /api/sources/[id]', () => {
  it('returns 202 with the deletion request id', async () => {
    mocks.sourcesRemove.mockResolvedValue({ deletionRequestId: 'd1' });
    const { DELETE } = sourcesIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deletionRequestId: 'd1' });
    expect(mocks.sourcesRemove).toHaveBeenCalledWith(user, ID);
  });

  it('audits a foreign access and returns 404 on not_found', async () => {
    mocks.sourcesRemove.mockRejectedValue(new AppError('not_found'));
    const { DELETE } = sourcesIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'source', ID);
  });

  it('honours the stored hub data choice: no choice is taken from the request', async () => {
    mocks.sourcesRemove.mockResolvedValue({ deletionRequestId: 'd1' });
    const { DELETE } = sourcesIdRoute;
    const res = await DELETE(
      new Request('http://x', { method: 'DELETE', body: JSON.stringify({ hubData: 'keep' }) }),
      params,
    );
    expect(res.status).toBe(202);
    expect(mocks.sourcesRemove).toHaveBeenCalledWith(user, ID);
  });

  it('carries hub.enabled on GET', async () => {
    mocks.sourcesGet.mockResolvedValue({ id: ID, hub: { enabled: false } });
    const { GET } = sourcesIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect((await res.json()).hub).toEqual({ enabled: false });
  });

  it('keeps GET working next to DELETE', async () => {
    mocks.sourcesGet.mockResolvedValue({ id: ID });
    const { GET } = sourcesIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID });
  });
});

describe('DELETE /api/content-items/[id]', () => {
  it('returns 202 with the deletion request id', async () => {
    mocks.itemsRemove.mockResolvedValue({ deletionRequestId: 'd2' });
    const { DELETE } = contentItemsIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deletionRequestId: 'd2' });
    expect(mocks.itemsRemove).toHaveBeenCalledWith(user, ID);
  });

  it('audits a foreign access and returns 404 on not_found', async () => {
    mocks.itemsRemove.mockRejectedValue(new AppError('not_found'));
    const { DELETE } = contentItemsIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'content_item', ID);
  });

  it('maps a pending-deletion conflict to 409 without auditing', async () => {
    mocks.itemsRemove.mockRejectedValue(new AppError('conflict'));
    const { DELETE } = contentItemsIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(409);
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });
});

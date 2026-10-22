import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as retroscansIdRoute from '../app/api/retroscans/[id]/route';
import * as retroscansIdConfirmRoute from '../app/api/retroscans/[id]/confirm/route';
import * as retroscansIdDismissRoute from '../app/api/retroscans/[id]/dismiss/route';
import * as contentItemsRoute from '../app/api/content-items/route';
import * as contentItemsIdReportRoute from '../app/api/content-items/[id]/report/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rGet: vi.fn(),
  rConfirm: vi.fn(),
  rDismiss: vi.fn(),
  cList: vi.fn(),
  cReport: vi.fn(),
}));

vi.mock('../lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@voicespark/core/services/retroscans', () => ({
  get: mocks.rGet,
  confirm: mocks.rConfirm,
  dismiss: mocks.rDismiss,
}));
vi.mock('@voicespark/core/services/content-items', () => ({
  list: mocks.cList,
  report: mocks.cReport,
}));

const user = { userId: 'u1', role: 'admin' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('retroscan routes', () => {
  it('GET returns the view', async () => {
    mocks.rGet.mockResolvedValue({ id: ID, status: 'scanning' });
    const { GET } = retroscansIdRoute;
    const res = await GET(new Request('http://x/api/retroscans/' + ID), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ID, status: 'scanning' });
  });

  it('GET audits and returns 404 for a foreign id', async () => {
    mocks.rGet.mockRejectedValue(new AppError('not_found'));
    const { GET } = retroscansIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'retroscan', ID);
  });

  it('confirm returns 202 with the deletion request id', async () => {
    mocks.rConfirm.mockResolvedValue({ deletionRequestId: 'd1' });
    const { POST } = retroscansIdConfirmRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ deletionRequestId: 'd1' });
  });

  it('confirm maps conflict to 409 without auditing', async () => {
    mocks.rConfirm.mockRejectedValue(new AppError('conflict'));
    const { POST } = retroscansIdConfirmRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(409);
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });

  it('dismiss returns 204', async () => {
    mocks.rDismiss.mockResolvedValue(undefined);
    const { POST } = retroscansIdDismissRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(204);
  });
});

describe('content-items routes', () => {
  it('GET passes filters and pagination', async () => {
    mocks.cList.mockResolvedValue({ items: [], nextCursor: null });
    const { GET } = contentItemsRoute;
    const res = await GET(
      new Request('http://x/api/content-items?sourceId=s1&query=hi&limit=5&cursor=c'),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(mocks.cList).toHaveBeenCalledWith(user, {
      limit: 5,
      cursor: 'c',
      sourceId: 's1',
      query: 'hi',
    });
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it('GET rejects an invalid limit', async () => {
    const { GET } = contentItemsRoute;
    const res = await GET(new Request('http://x/api/content-items?limit=0'), undefined);
    expect(res.status).toBe(422);
  });

  it('report returns 202 and accepts an empty body', async () => {
    mocks.cReport.mockResolvedValue({ reportId: 'r1', deletionRequestId: 'd1' });
    const { POST } = contentItemsIdReportRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(202);
    expect(mocks.cReport).toHaveBeenCalledWith(user, ID, undefined);
  });

  it('report validates the category', async () => {
    const { POST } = contentItemsIdReportRoute;
    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ category: 'nope' }) }),
      params,
    );
    expect(res.status).toBe(422);
    expect(mocks.cReport).not.toHaveBeenCalled();
  });

  it('report audits and returns 404 for a foreign item', async () => {
    mocks.cReport.mockRejectedValue(new AppError('not_found'));
    const { POST } = contentItemsIdReportRoute;
    const res = await POST(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'content_item', ID);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as filterCategoriesRoute from '../app/api/filter-categories/route';
import * as filterPreferencesRoute from '../app/api/filter-preferences/route';
import * as exclusionRulesRoute from '../app/api/exclusion-rules/route';
import * as exclusionRulesIdRoute from '../app/api/exclusion-rules/[id]/route';
import * as importsIdExclusionSummaryRoute from '../app/api/imports/[id]/exclusion-summary/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  prefsGet: vi.fn(),
  prefsUpdate: vi.fn(),
  rulesList: vi.fn(),
  rulesCreate: vi.fn(),
  rulesUpdate: vi.fn(),
  rulesRemove: vi.fn(),
  exclusionSummary: vi.fn(),
}));

// Routes import guards and http through the `@/` alias.
vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async () => import('../lib/http'));
vi.mock('@voicespark/core/services/filter-preferences', () => ({
  get: mocks.prefsGet,
  update: mocks.prefsUpdate,
}));
vi.mock('@voicespark/core/services/exclusion-rules', () => ({
  list: mocks.rulesList,
  create: mocks.rulesCreate,
  update: mocks.rulesUpdate,
  remove: mocks.rulesRemove,
}));
vi.mock('@voicespark/core/services/imports', () => ({ exclusionSummary: mocks.exclusionSummary }));

const user = { userId: 'u1', role: 'admin' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };

const json = (method: string, body: unknown) =>
  new Request('http://x/api', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/filter-categories', () => {
  it('returns the 10 catalog entries without internal handling', async () => {
    const { GET } = filterCategoriesRoute;
    const res = await GET(new Request('http://x'), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body).toHaveLength(10);
    expect(body[0]).toEqual({
      key: 'passwords',
      label: expect.any(String),
      description: expect.any(String),
      locked: true,
      defaultSelected: true,
    });
    expect(body.every((c) => !('handling' in c))).toBe(true);
  });

  it('requires a signed-in user', async () => {
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    const { GET } = filterCategoriesRoute;
    expect((await GET(new Request('http://x'), undefined)).status).toBe(401);
  });
});

describe('/api/filter-preferences', () => {
  it('GET returns the view', async () => {
    mocks.prefsGet.mockResolvedValue({ selectedCategories: ['passwords'], version: 0 });
    const { GET } = filterPreferencesRoute;
    const res = await GET(new Request('http://x'), undefined);
    expect(await res.json()).toEqual({ selectedCategories: ['passwords'], version: 0 });
    expect(mocks.prefsGet).toHaveBeenCalledWith(user);
  });

  it('PUT passes the selection and returns preferences with retroscanId', async () => {
    mocks.prefsUpdate.mockResolvedValue({ preferences: { version: 1 }, retroscanId: null });
    const { PUT } = filterPreferencesRoute;
    const res = await PUT(json('PUT', { selectedCategories: ['passwords', 'health'] }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preferences: { version: 1 }, retroscanId: null });
    expect(mocks.prefsUpdate).toHaveBeenCalledWith(user, ['passwords', 'health']);
  });

  it('PUT maps category_locked to 422', async () => {
    mocks.prefsUpdate.mockRejectedValue(new AppError('category_locked'));
    const { PUT } = filterPreferencesRoute;
    const res = await PUT(json('PUT', { selectedCategories: ['health'] }), undefined);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('category_locked');
  });

  it('PUT rejects a malformed body', async () => {
    const { PUT } = filterPreferencesRoute;
    const res = await PUT(json('PUT', { selectedCategories: 'passwords' }), undefined);
    expect(res.status).toBe(422);
    expect(mocks.prefsUpdate).not.toHaveBeenCalled();
  });
});

describe('/api/exclusion-rules', () => {
  it('GET lists rules', async () => {
    mocks.rulesList.mockResolvedValue([{ id: ID }]);
    const { GET } = exclusionRulesRoute;
    expect(await (await GET(new Request('http://x'), undefined)).json()).toEqual([{ id: ID }]);
  });

  it('POST creates a rule with 201', async () => {
    mocks.rulesCreate.mockResolvedValue({ rule: { id: ID }, retroscanId: 'r1' });
    const { POST } = exclusionRulesRoute;
    const res = await POST(json('POST', { type: 'domain', value: 'example.com' }), undefined);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ rule: { id: ID }, retroscanId: 'r1' });
    expect(mocks.rulesCreate).toHaveBeenCalledWith(user, { type: 'domain', value: 'example.com' });
  });

  it('POST rejects an unknown type', async () => {
    const { POST } = exclusionRulesRoute;
    const res = await POST(json('POST', { type: 'subject', value: 'x' }), undefined);
    expect(res.status).toBe(422);
    expect(mocks.rulesCreate).not.toHaveBeenCalled();
  });

  it('POST maps the rule limit conflict to 409', async () => {
    mocks.rulesCreate.mockRejectedValue(new AppError('conflict', 'rule limit reached'));
    const { POST } = exclusionRulesRoute;
    expect(
      (await POST(json('POST', { type: 'keyword', value: 'invoice' }), undefined)).status,
    ).toBe(409);
  });

  it('PATCH updates the value', async () => {
    mocks.rulesUpdate.mockResolvedValue({ rule: { id: ID }, retroscanId: null });
    const { PATCH } = exclusionRulesIdRoute;
    const res = await PATCH(json('PATCH', { value: 'news.example.com' }), params);
    expect(res.status).toBe(200);
    expect(mocks.rulesUpdate).toHaveBeenCalledWith(user, ID, { value: 'news.example.com' });
  });

  it('PATCH audits and returns 404 for a foreign id', async () => {
    mocks.rulesUpdate.mockRejectedValue(new AppError('not_found'));
    const { PATCH } = exclusionRulesIdRoute;
    const res = await PATCH(json('PATCH', { value: 'x' }), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'exclusion_rule', ID);
  });

  it('DELETE returns 204', async () => {
    mocks.rulesRemove.mockResolvedValue(undefined);
    const { DELETE } = exclusionRulesIdRoute;
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(res.status).toBe(204);
    expect(mocks.rulesRemove).toHaveBeenCalledWith(user, ID);
  });

  it('DELETE audits and returns 404 for a foreign id', async () => {
    mocks.rulesRemove.mockRejectedValue(new AppError('not_found'));
    const { DELETE } = exclusionRulesIdRoute;
    expect((await DELETE(new Request('http://x', { method: 'DELETE' }), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'exclusion_rule', ID);
  });
});

describe('GET /api/imports/{id}/exclusion-summary', () => {
  it('returns the summary', async () => {
    const summary = {
      importJobId: ID,
      categories: [],
      skipped: [{ reason: 'too_large', count: 2 }],
    };
    mocks.exclusionSummary.mockResolvedValue(summary);
    const { GET } = importsIdExclusionSummaryRoute;
    const res = await GET(new Request('http://x'), params);
    expect(await res.json()).toEqual(summary);
    expect(mocks.exclusionSummary).toHaveBeenCalledWith(user, ID);
  });

  it('audits and returns 404 for a foreign job', async () => {
    mocks.exclusionSummary.mockRejectedValue(new AppError('not_found'));
    const { GET } = importsIdExclusionSummaryRoute;
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'import_job', ID);
  });
});

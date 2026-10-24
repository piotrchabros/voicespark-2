import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as adminSettingsRoute from '../app/api/admin/settings/route';
import * as adminAuditRoute from '../app/api/admin/audit/route';
import * as adminSystemHealthRoute from '../app/api/admin/system/health/route';
import * as adminMetricsRatingsRoute from '../app/api/admin/metrics/ratings/route';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listSettings: vi.fn(),
  setSetting: vi.fn(),
  health: vi.fn(),
  auditQuery: vi.fn(),
  ratingsMetrics: vi.fn(),
}));

vi.mock('../lib/guards', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@voicespark/core/services/settings', () => ({ setSetting: mocks.setSetting }));
vi.mock('@voicespark/core/services/admin-system', () => ({
  listSettings: mocks.listSettings,
  health: mocks.health,
  auditQuery: mocks.auditQuery,
  ratingsMetrics: mocks.ratingsMetrics,
}));

const ADMIN = { userId: 'a1', role: 'admin' as const };
const KEY = 'profile.min_authored_words';
const view = {
  key: KEY,
  value: 50,
  defaultValue: 100,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const put = (body: unknown) =>
  new Request('http://x/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue(ADMIN);
});

describe('admin settings route', () => {
  it('GET converts updatedAt to ISO', async () => {
    mocks.listSettings.mockResolvedValue([
      view,
      { ...view, key: 'draft.memory_context_limit', updatedAt: null },
    ]);
    const { GET } = adminSettingsRoute;
    const res = await GET(new Request('http://x/api/admin/settings'), undefined);
    const json = await res.json();
    expect(json.settings[0].updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(json.settings[1].updatedAt).toBeNull();
  });

  it('PUT sets the value as the admin', async () => {
    mocks.listSettings.mockResolvedValue([view]);
    const { PUT } = adminSettingsRoute;
    const res = await PUT(put({ key: KEY, value: 50 }), undefined);
    expect(res.status).toBe(200);
    expect(mocks.setSetting).toHaveBeenCalledWith(KEY, 50, 'a1');
  });

  it('PUT rejects an unknown key', async () => {
    const { PUT } = adminSettingsRoute;
    const res = await PUT(put({ key: 'nope', value: 1 }), undefined);
    expect(res.status).toBe(422);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it('rejects non-admins', async () => {
    mocks.requireAdmin.mockRejectedValue(new AppError('admin_required'));
    const { GET } = adminSettingsRoute;
    expect((await GET(new Request('http://x/api/admin/settings'), undefined)).status).toBe(403);
  });

  it('lists and sets hub.daily_thread_cap_per_user', async () => {
    const cap = { key: 'hub.daily_thread_cap_per_user', value: 500, defaultValue: 500, updatedAt: null };
    mocks.listSettings.mockResolvedValue([view, cap]);
    const { GET, PUT } = adminSettingsRoute;
    const listed = await (await GET(new Request('http://x/api/admin/settings'), undefined)).json();
    expect(listed.settings.map((s: { key: string }) => s.key)).toContain(cap.key);
    mocks.listSettings.mockResolvedValue([view, { ...cap, value: 200 }]);
    const res = await PUT(put({ key: cap.key, value: 200 }), undefined);
    expect(res.status).toBe(200);
    expect(mocks.setSetting).toHaveBeenCalledWith(cap.key, 200, 'a1');
    expect((await res.json()).setting).toEqual({ ...cap, value: 200 });
  });
});

describe('admin audit route', () => {
  it('passes parsed filters to the service', async () => {
    mocks.auditQuery.mockResolvedValue({ items: [], nextCursor: null });
    const { GET } = adminAuditRoute;
    const res = await GET(
      new Request(
        'http://x/api/admin/audit?action=settings.changed&from=2026-01-01T00:00:00Z&limit=5',
      ),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(mocks.auditQuery).toHaveBeenCalledWith({
      action: 'settings.changed',
      from: new Date('2026-01-01T00:00:00Z'),
      limit: 5,
    });
  });

  it('rejects a malformed date', async () => {
    const { GET } = adminAuditRoute;
    const res = await GET(new Request('http://x/api/admin/audit?from=yesterday'), undefined);
    expect(res.status).toBe(422);
  });
});

describe('admin health and metrics routes', () => {
  it('health returns counts and hub aggregates', async () => {
    // Context Hub aggregates (FR-029): numbers only.
    const hub = {
      llmCallsToday: 12,
      inputTokensToday: 34000,
      outputTokensToday: 5600,
      threadsPending: 3,
      threadsFailed: 1,
      syncFailed: 0,
    };
    mocks.health.mockResolvedValue({
      queues: { import: { waiting: 1, active: 0, failed: 0, delayed: 0 } },
      overdueDeletions: 0,
      credentialAuditHits: 2,
      hub,
    });
    const { GET } = adminSystemHealthRoute;
    const res = await GET(new Request('http://x/api/admin/system/health'), undefined);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.credentialAuditHits).toBe(2);
    expect(json.hub).toEqual(hub);
  });

  it('ratings returns aggregates', async () => {
    const agg = { rated: 4, soundsLikeMe: 3, share: 0.75 };
    mocks.ratingsMetrics.mockResolvedValue({
      profiles: agg,
      drafts: { rated: 0, soundsLikeMe: 0, share: null, byContentType: {} },
    });
    const { GET } = adminMetricsRatingsRoute;
    const res = await GET(
      new Request('http://x/api/admin/metrics/ratings?to=2026-02-01T00:00:00Z'),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(mocks.ratingsMetrics).toHaveBeenCalledWith({ to: new Date('2026-02-01T00:00:00Z') });
  });
});

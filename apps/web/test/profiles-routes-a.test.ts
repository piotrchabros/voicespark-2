import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as definitionsRoute from '../app/api/definitions/route';
import * as definitionChoicesRoute from '../app/api/definition-choices/route';
import * as profilesEligibilityRoute from '../app/api/profiles/eligibility/route';
import * as profilesRoute from '../app/api/profiles/route';
import * as profilesGenerateRoute from '../app/api/profiles/generate/route';
import * as profileGenerationsIdRoute from '../app/api/profile-generations/[id]/route';
import * as profilesIdRoute from '../app/api/profiles/[id]/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  autoChoose: vi.fn(),
  listAvailable: vi.fn(),
  setChoices: vi.fn(),
  eligibility: vi.fn(),
  list: vi.fn(),
  generate: vi.fn(),
  getGeneration: vi.fn(),
  get: vi.fn(),
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
vi.mock('@voicespark/core/services/definitions', () => ({
  autoChooseIfSingle: mocks.autoChoose,
  listAvailable: mocks.listAvailable,
  setChoices: mocks.setChoices,
}));
vi.mock('@voicespark/core/services/profiles', () => ({
  eligibility: mocks.eligibility,
  list: mocks.list,
  generate: mocks.generate,
  getGeneration: mocks.getGeneration,
  get: mocks.get,
  remove: mocks.remove,
}));

const user = { userId: 'u1', role: 'user' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: ID }) };
const post = (body?: string) => new Request('http://x', { method: 'POST', body });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('definition routes', () => {
  it('GET auto-chooses then lists', async () => {
    mocks.listAvailable.mockResolvedValue([{ id: ID, chosen: true }]);
    const { GET } = definitionsRoute;
    const res = await GET(new Request('http://x'), undefined);
    expect(res.status).toBe(200);
    expect(mocks.autoChoose).toHaveBeenCalledWith(user);
    expect(await res.json()).toEqual([{ id: ID, chosen: true }]);
  });

  it('PUT choices validates and returns the list', async () => {
    mocks.setChoices.mockResolvedValue([]);
    const { PUT } = definitionChoicesRoute;
    const bad = await PUT(
      new Request('http://x', { method: 'PUT', body: '{"definitionIds":[]}' }),
      undefined,
    );
    expect(bad.status).toBe(422);
    const ok = await PUT(
      new Request('http://x', { method: 'PUT', body: JSON.stringify({ definitionIds: [ID] }) }),
      undefined,
    );
    expect(ok.status).toBe(200);
    expect(mocks.setChoices).toHaveBeenCalledWith(user, [ID]);
  });
});

describe('profile routes A', () => {
  it('eligibility and list', async () => {
    mocks.eligibility.mockResolvedValue({ eligible: true });
    mocks.list.mockResolvedValue([]);
    const e = profilesEligibilityRoute;
    expect(await (await e.GET(new Request('http://x'), undefined)).json()).toEqual({
      eligible: true,
    });
    const l = profilesRoute;
    expect(await (await l.GET(new Request('http://x'), undefined)).json()).toEqual([]);
  });

  it('generate accepts an empty body, rate limits and returns 202', async () => {
    mocks.generate.mockResolvedValue({ generations: [{ id: 'g1', profileId: 'p1' }] });
    const { POST } = profilesGenerateRoute;
    const res = await POST(post(), undefined);
    expect(res.status).toBe(202);
    expect(mocks.rateLimit).toHaveBeenCalledWith('profile-gen:u1', 10, 3600);
    expect(mocks.generate).toHaveBeenCalledWith(user, undefined);
    await POST(post(JSON.stringify({ definitionIds: [ID] })), undefined);
    expect(mocks.generate).toHaveBeenLastCalledWith(user, [ID]);
  });

  it('generate maps rate_limited and service errors', async () => {
    const { POST } = profilesGenerateRoute;
    mocks.rateLimit.mockRejectedValueOnce(new AppError('rate_limited'));
    expect((await POST(post(), undefined)).status).toBe(429);
    mocks.generate.mockRejectedValue(new AppError('insufficient_content'));
    expect((await POST(post(), undefined)).status).toBe(422);
  });

  it('generation GET audits a foreign id', async () => {
    mocks.getGeneration.mockRejectedValue(new AppError('not_found'));
    const { GET } = profileGenerationsIdRoute;
    const res = await GET(new Request('http://x'), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'profile_generation', ID);
  });

  it('profile GET returns the view and audits 404', async () => {
    const { GET, DELETE } = profilesIdRoute;
    mocks.get.mockResolvedValue({ profile: { id: ID }, latestVersion: null });
    expect((await GET(new Request('http://x'), params)).status).toBe(200);
    mocks.get.mockRejectedValue(new AppError('not_found'));
    expect((await GET(new Request('http://x'), params)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'profile', ID);

    mocks.remove.mockResolvedValue(undefined);
    const del = await DELETE(new Request('http://x', { method: 'DELETE' }), params);
    expect(del.status).toBe(202);
    expect(await del.json()).toEqual({});
  });

  it('profile GET passes a document latestVersion through unchanged', async () => {
    const view = {
      profile: { id: ID },
      latestVersion: { id: ID, format: 'document', promptSource: 'default', excerptSources: {} },
    };
    mocks.get.mockResolvedValue(view);
    const res = await profilesIdRoute.GET(new Request('http://x'), params);
    expect(await res.json()).toEqual(view);
  });
});

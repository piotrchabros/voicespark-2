import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as listRoute from '../app/api/hub/[kind]/route';
import * as itemRoute from '../app/api/hub/[kind]/[id]/route';
import * as emailsRoute from '../app/api/hub/[kind]/[id]/emails/route';
import * as emailIdRoute from '../app/api/hub/[kind]/[id]/emails/[emailId]/route';
import * as domainsRoute from '../app/api/hub/[kind]/[id]/domains/route';
import * as domainIdRoute from '../app/api/hub/[kind]/[id]/domains/[domainId]/route';

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  deletePreview: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  addEmail: vi.fn(),
  removeEmail: vi.fn(),
  addDomain: vi.fn(),
  removeDomain: vi.fn(),
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/hub/records', () => ({
  list: mocks.list,
  create: mocks.create,
  get: mocks.get,
  deletePreview: mocks.deletePreview,
  patch: mocks.patch,
  remove: mocks.remove,
  addEmail: mocks.addEmail,
  removeEmail: mocks.removeEmail,
  addDomain: mocks.addDomain,
  removeDomain: mocks.removeDomain,
}));

const user = { userId: 'u1', role: 'user' as const };
const admin = { userId: 'a1', role: 'admin' as const };
const ID = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';

const kindParams = (kind: string) => ({ params: Promise.resolve({ kind }) });
const idParams = (kind: string, id = ID) => ({ params: Promise.resolve({ kind, id }) });
const subParams = <K extends 'emailId' | 'domainId'>(kind: string, key: K) => ({
  params: Promise.resolve({ kind, id: ID, [key]: SUB } as { kind: string; id: string } & Record<
    K,
    string
  >),
});

function req(method: string, body?: unknown, url = 'http://x/api/hub/people'): Request {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const person = {
  id: ID,
  name: 'Anna Nowak',
  roleTitle: 'CTO',
  phone: null,
  description: null,
  emails: [{ id: SUB, address: 'anna@example.com', isPrimary: true, origin: 'user' }],
  ownerFields: ['name'],
  createdFrom: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const company = {
  id: ID,
  name: 'Acme',
  website: 'https://acme.example',
  industry: null,
  description: null,
  domains: [{ id: SUB, domain: 'acme.example', origin: 'user' }],
  ownerFields: [],
  createdFrom: 'email',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const project = {
  id: ID,
  name: 'Apollo',
  status: 'active',
  startDate: '2026-01-01',
  endDate: null,
  description: null,
  ownerFields: [],
  createdFrom: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const sync = { status: 'pending', lastSyncedAt: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/hub/{kind}', () => {
  it('returns items with counts and passes sort, order and paging to the service', async () => {
    const items = [
      { ...person, linkCounts: { companies: 1, projects: 0 }, noteCount: 2, fileCount: 0, sync },
    ];
    mocks.list.mockResolvedValue({ items, nextCursor: 'c2' });
    const res = await listRoute.GET(
      req('GET', undefined, 'http://x/api/hub/people?sort=updated&order=desc&cursor=c1&limit=10'),
      kindParams('people'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items, nextCursor: 'c2' });
    expect(mocks.list).toHaveBeenCalledWith(
      user,
      'person',
      expect.objectContaining({ sort: 'updated', order: 'desc', cursor: 'c1', limit: 10 }),
    );
  });

  it('defaults to sort=name with limit 25', async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    await listRoute.GET(req('GET', undefined, 'http://x/api/hub/projects'), kindParams('projects'));
    expect(mocks.list).toHaveBeenCalledWith(
      user,
      'project',
      expect.objectContaining({ sort: 'name', limit: 25 }),
    );
  });

  it('maps people, companies and projects to the service kinds', async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    await listRoute.GET(req('GET'), kindParams('companies'));
    expect(mocks.list.mock.calls[0]?.[1]).toBe('company');
  });

  it('rejects an invalid sort with 422', async () => {
    const res = await listRoute.GET(
      req('GET', undefined, 'http://x/api/hub/people?sort=bogus'),
      kindParams('people'),
    );
    expect(res.status).toBe(422);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('returns 404 for a kind outside people|companies|projects', async () => {
    for (const kind of ['person', 'notes', 'links', 'search']) {
      const res = await listRoute.GET(req('GET'), kindParams(kind));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated and 403 when suspended', async () => {
    mocks.requireUser.mockRejectedValueOnce(new AppError('unauthenticated'));
    expect((await listRoute.GET(req('GET'), kindParams('people'))).status).toBe(401);
    mocks.requireUser.mockRejectedValueOnce(new AppError('account_suspended'));
    expect((await listRoute.GET(req('GET'), kindParams('people'))).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('POST /api/hub/{kind}', () => {
  it('creates a person with emails and returns 201 {record, similar}', async () => {
    const result = { record: person, similar: [{ id: SUB, name: 'anna nowak' }] };
    mocks.create.mockResolvedValue(result);
    const body = { name: 'Anna Nowak', roleTitle: 'CTO', emails: ['Anna@Example.com', 'a@x.pl'] };
    const res = await listRoute.POST(req('POST', body), kindParams('people'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(result);
    expect(mocks.create).toHaveBeenCalledWith(user, 'person', expect.objectContaining(body));
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-records:u1', 120, 60);
  });

  it('creates a company with domains and a project with dates', async () => {
    mocks.create.mockResolvedValueOnce({ record: company, similar: [] });
    const c = await listRoute.POST(
      req('POST', { name: 'Acme', domains: ['acme.example'] }),
      kindParams('companies'),
    );
    expect(c.status).toBe(201);
    expect((await c.json()).record.domains).toEqual(company.domains);
    expect(mocks.create.mock.calls[0]?.[1]).toBe('company');

    mocks.create.mockResolvedValueOnce({ record: project, similar: [] });
    const p = await listRoute.POST(
      req('POST', { name: 'Apollo', status: 'active', startDate: '2026-01-01' }),
      kindParams('projects'),
    );
    expect(p.status).toBe(201);
    expect((await p.json()).record.status).toBe('active');
    expect(mocks.create.mock.calls[1]?.[1]).toBe('project');
  });

  it('rejects a non-JSON body, a non-object body and a missing name with 422 before the service', async () => {
    const bad = new Request('http://x/api/hub/people', { method: 'POST', body: 'not json' });
    expect((await listRoute.POST(bad, kindParams('people'))).status).toBe(422);
    expect((await listRoute.POST(req('POST', []), kindParams('people'))).status).toBe(422);
    expect((await listRoute.POST(req('POST', {}), kindParams('people'))).status).toBe(422);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('passes service validation, sensitive_content and conflict errors through with their details', async () => {
    mocks.create.mockRejectedValueOnce(new AppError('validation_failed'));
    expect((await listRoute.POST(req('POST', { name: 'x' }), kindParams('people'))).status).toBe(
      422,
    );

    mocks.create.mockRejectedValueOnce(
      new AppError('sensitive_content', undefined, { fields: ['phone'] }),
    );
    const sensitive = await listRoute.POST(
      req('POST', { name: 'x', phone: '1' }),
      kindParams('people'),
    );
    expect(sensitive.status).toBe(422);
    const sBody = await sensitive.json();
    expect(sBody.error.code).toBe('sensitive_content');
    expect(sBody.error.details).toEqual({ fields: ['phone'] });

    mocks.create.mockRejectedValueOnce(new AppError('conflict'));
    expect(
      (await listRoute.POST(req('POST', { name: 'x', emails: ['a@b.pl'] }), kindParams('people')))
        .status,
    ).toBe(409);
  });

  it('returns 429 when the rate limit is exceeded and does not call the service', async () => {
    mocks.rateLimit.mockRejectedValue(new AppError('rate_limited'));
    const res = await listRoute.POST(req('POST', { name: 'x' }), kindParams('people'));
    expect(res.status).toBe(429);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns 404 for a bad kind and 401 / 403 from the guard', async () => {
    expect((await listRoute.POST(req('POST', { name: 'x' }), kindParams('bogus'))).status).toBe(
      404,
    );
    mocks.requireUser.mockRejectedValueOnce(new AppError('unauthenticated'));
    expect((await listRoute.POST(req('POST', { name: 'x' }), kindParams('people'))).status).toBe(
      401,
    );
    mocks.requireUser.mockRejectedValueOnce(new AppError('account_suspended'));
    expect((await listRoute.POST(req('POST', { name: 'x' }), kindParams('people'))).status).toBe(
      403,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/hub/{kind}/{id}', () => {
  it('returns the record with links and sync', async () => {
    const result = {
      record: person,
      links: [
        {
          link: { id: SUB, kind: 'person_company' },
          other: { kind: 'company', id: SUB, name: 'Acme' },
        },
      ],
      sync,
    };
    mocks.get.mockResolvedValue(result);
    const res = await itemRoute.GET(req('GET'), idParams('people'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mocks.get).toHaveBeenCalledWith(user, 'person', ID);
  });

  it('?deletePreview=1 returns the counts instead', async () => {
    mocks.deletePreview.mockResolvedValue({ notes: 3, files: 1, links: 2 });
    const res = await itemRoute.GET(
      req('GET', undefined, `http://x/api/hub/companies/${ID}?deletePreview=1`),
      idParams('companies'),
    );
    expect(await res.json()).toEqual({ notes: 3, files: 1, links: 2 });
    expect(mocks.deletePreview).toHaveBeenCalledWith(user, 'company', ID);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown kind and 404 for a foreign id with an audit entry', async () => {
    expect((await itemRoute.GET(req('GET'), idParams('bogus'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();

    mocks.get.mockRejectedValue(new AppError('not_found'));
    const res = await itemRoute.GET(req('GET'), idParams('projects'));
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_project', ID);
  });

  it('audits an admin reading another user id and still returns 404', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.get.mockRejectedValue(new AppError('not_found'));
    const res = await itemRoute.GET(req('GET'), idParams('people'));
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_person', ID);
  });

  it('audits the delete preview of a foreign id with the matching resource type', async () => {
    mocks.deletePreview.mockRejectedValue(new AppError('not_found'));
    const res = await itemRoute.GET(
      req('GET', undefined, `http://x/api/hub/companies/${ID}?deletePreview=1`),
      idParams('companies'),
    );
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_company', ID);
  });

  it('returns 401 when unauthenticated', async () => {
    mocks.requireUser.mockRejectedValue(new AppError('unauthenticated'));
    expect((await itemRoute.GET(req('GET'), idParams('people'))).status).toBe(401);
  });
});

describe('PATCH /api/hub/{kind}/{id}', () => {
  it('returns {record, similar} and passes null through as a cleared field', async () => {
    const result = { record: person, similar: [] };
    mocks.patch.mockResolvedValue(result);
    const res = await itemRoute.PATCH(
      req('PATCH', { roleTitle: null, name: 'Anna K' }),
      idParams('people'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mocks.patch).toHaveBeenCalledWith(user, 'person', ID, {
      roleTitle: null,
      name: 'Anna K',
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-records:u1', 120, 60);
  });

  it('rejects a non-object body with 422', async () => {
    expect((await itemRoute.PATCH(req('PATCH', 'x'), idParams('people'))).status).toBe(422);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('maps service 422 (end before start) and 409 (conflict)', async () => {
    mocks.patch.mockRejectedValueOnce(new AppError('validation_failed'));
    expect(
      (await itemRoute.PATCH(req('PATCH', { endDate: '2020-01-01' }), idParams('projects'))).status,
    ).toBe(422);
    mocks.patch.mockRejectedValueOnce(new AppError('conflict'));
    expect((await itemRoute.PATCH(req('PATCH', { name: 'x' }), idParams('companies'))).status).toBe(
      409,
    );
  });

  it('audits a 404 for a foreign id and returns 404 for a bad kind', async () => {
    mocks.patch.mockRejectedValue(new AppError('not_found'));
    expect((await itemRoute.PATCH(req('PATCH', { name: 'x' }), idParams('people'))).status).toBe(
      404,
    );
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_person', ID);
    expect((await itemRoute.PATCH(req('PATCH', { name: 'x' }), idParams('bogus'))).status).toBe(
      404,
    );
  });

  it('returns 429 when rate limited', async () => {
    mocks.rateLimit.mockRejectedValue(new AppError('rate_limited'));
    expect((await itemRoute.PATCH(req('PATCH', { name: 'x' }), idParams('people'))).status).toBe(
      429,
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/hub/{kind}/{id}', () => {
  it('returns 204', async () => {
    mocks.remove.mockResolvedValue(undefined);
    const res = await itemRoute.DELETE(req('DELETE'), idParams('projects'));
    expect(res.status).toBe(204);
    expect(mocks.remove).toHaveBeenCalledWith(user, 'project', ID);
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-records:u1', 120, 60);
  });

  it('audits a foreign id as a 404 for an admin too', async () => {
    mocks.requireUser.mockResolvedValue(admin);
    mocks.remove.mockRejectedValue(new AppError('not_found'));
    const res = await itemRoute.DELETE(req('DELETE'), idParams('companies'));
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(admin, 'hub_company', ID);
  });

  it('returns 404 for a bad kind without calling the service', async () => {
    expect((await itemRoute.DELETE(req('DELETE'), idParams('bogus'))).status).toBe(404);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe('/api/hub/{kind}/{id}/emails', () => {
  it('POST adds an address and returns 201', async () => {
    const email = { id: SUB, address: 'new@example.com', isPrimary: false, origin: 'user' };
    mocks.addEmail.mockResolvedValue(email);
    const res = await emailsRoute.POST(
      req('POST', { address: 'New@Example.com' }),
      idParams('people'),
    );
    expect(res.status).toBe(201);
    expect(mocks.addEmail).toHaveBeenCalledWith(user, 'person', ID, { address: 'New@Example.com' });
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-records:u1', 120, 60);
    expect(await res.json()).toEqual(expect.objectContaining({ id: SUB }));
  });

  it('POST rejects a missing address with 422 and maps conflict and sensitive_content', async () => {
    expect((await emailsRoute.POST(req('POST', {}), idParams('people'))).status).toBe(422);
    expect(mocks.addEmail).not.toHaveBeenCalled();
    mocks.addEmail.mockRejectedValueOnce(new AppError('conflict'));
    expect(
      (await emailsRoute.POST(req('POST', { address: 'a@b.pl' }), idParams('people'))).status,
    ).toBe(409);
    mocks.addEmail.mockRejectedValueOnce(
      new AppError('sensitive_content', undefined, { fields: ['address'] }),
    );
    expect(
      (await emailsRoute.POST(req('POST', { address: 'a@b.pl' }), idParams('people'))).status,
    ).toBe(422);
  });

  it('POST audits a foreign person id as a 404', async () => {
    mocks.addEmail.mockRejectedValue(new AppError('not_found'));
    const res = await emailsRoute.POST(req('POST', { address: 'a@b.pl' }), idParams('people'));
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_person', ID);
  });

  it('POST returns 404 for any kind other than people', async () => {
    for (const kind of ['companies', 'projects', 'bogus']) {
      expect(
        (await emailsRoute.POST(req('POST', { address: 'a@b.pl' }), idParams(kind))).status,
      ).toBe(404);
    }
    expect(mocks.addEmail).not.toHaveBeenCalled();
  });

  it('DELETE returns 204 and audits a 404', async () => {
    mocks.removeEmail.mockResolvedValueOnce(undefined);
    const res = await emailIdRoute.DELETE(req('DELETE'), subParams('people', 'emailId'));
    expect(res.status).toBe(204);
    expect(mocks.removeEmail).toHaveBeenCalledWith(user, 'person', ID, SUB);

    mocks.removeEmail.mockRejectedValueOnce(new AppError('not_found'));
    const miss = await emailIdRoute.DELETE(req('DELETE'), subParams('people', 'emailId'));
    expect(miss.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_person', ID);
  });

  it('DELETE returns 404 for a non-people kind', async () => {
    expect(
      (await emailIdRoute.DELETE(req('DELETE'), subParams('companies', 'emailId'))).status,
    ).toBe(404);
    expect(mocks.removeEmail).not.toHaveBeenCalled();
  });
});

describe('/api/hub/{kind}/{id}/domains', () => {
  it('POST adds a domain and returns 201', async () => {
    const domain = { id: SUB, domain: 'acme.example', origin: 'user' };
    mocks.addDomain.mockResolvedValue(domain);
    const res = await domainsRoute.POST(
      req('POST', { domain: 'acme.example' }),
      idParams('companies'),
    );
    expect(res.status).toBe(201);
    expect(mocks.addDomain).toHaveBeenCalledWith(user, 'company', ID, { domain: 'acme.example' });
    expect(mocks.rateLimit).toHaveBeenCalledWith('hub-records:u1', 120, 60);
    expect(await res.json()).toEqual(expect.objectContaining({ id: SUB }));
  });

  it('POST rejects a missing domain with 422 and maps conflict and validation errors', async () => {
    expect((await domainsRoute.POST(req('POST', {}), idParams('companies'))).status).toBe(422);
    expect(mocks.addDomain).not.toHaveBeenCalled();
    mocks.addDomain.mockRejectedValueOnce(new AppError('conflict'));
    expect(
      (await domainsRoute.POST(req('POST', { domain: 'acme.example' }), idParams('companies')))
        .status,
    ).toBe(409);
    mocks.addDomain.mockRejectedValueOnce(new AppError('validation_failed'));
    expect(
      (await domainsRoute.POST(req('POST', { domain: 'www.acme.example' }), idParams('companies')))
        .status,
    ).toBe(422);
  });

  it('POST audits a foreign company id as a 404 and refuses other kinds', async () => {
    mocks.addDomain.mockRejectedValue(new AppError('not_found'));
    const res = await domainsRoute.POST(
      req('POST', { domain: 'a.example' }),
      idParams('companies'),
    );
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_company', ID);
    for (const kind of ['people', 'projects']) {
      expect(
        (await domainsRoute.POST(req('POST', { domain: 'a.example' }), idParams(kind))).status,
      ).toBe(404);
    }
  });

  it('DELETE returns 204, audits a 404 and refuses non-company kinds', async () => {
    mocks.removeDomain.mockResolvedValueOnce(undefined);
    const res = await domainIdRoute.DELETE(req('DELETE'), subParams('companies', 'domainId'));
    expect(res.status).toBe(204);
    expect(mocks.removeDomain).toHaveBeenCalledWith(user, 'company', ID, SUB);

    mocks.removeDomain.mockRejectedValueOnce(new AppError('not_found'));
    const miss = await domainIdRoute.DELETE(req('DELETE'), subParams('companies', 'domainId'));
    expect(miss.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_company', ID);

    expect(
      (await domainIdRoute.DELETE(req('DELETE'), subParams('people', 'domainId'))).status,
    ).toBe(404);
  });
});

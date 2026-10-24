import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@voicespark/core/errors';
import * as mailboxesRoute from '../app/api/hub/mailboxes/route';
import * as enableRoute from '../app/api/hub/mailboxes/[sourceId]/enable/route';
import * as disableRoute from '../app/api/hub/mailboxes/[sourceId]/disable/route';
import * as retryRoute from '../app/api/hub/mailboxes/[sourceId]/threads/[threadId]/retry/route';
import * as ignoreRulesRoute from '../app/api/hub/ignore-rules/route';
import * as ignoreRuleIdRoute from '../app/api/hub/ignore-rules/[id]/route';
import * as sourcesRoute from '../app/api/hub/[kind]/[id]/sources/route';

// Mailbox settings, ignore rules and the sources display (contracts/http-api.md "Mailboxes and ignore rules" and
// "GET /api/hub/{kind}/{id}/sources"; US3 sub-steps a, f, g; FR-012, FR-018, FR-019, FR-021, FR-022).

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  auditForeignAccess: vi.fn(),
  rateLimit: vi.fn(),
  mailboxes: { list: vi.fn(), enable: vi.fn(), disable: vi.fn(), retryThread: vi.fn() },
  ignoreRules: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
  sources: { sourcesForRecord: vi.fn() },
}));

vi.mock('@/lib/guards', () => ({
  requireUser: mocks.requireUser,
  auditForeignAccess: mocks.auditForeignAccess,
}));
vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@voicespark/core/services/hub/mailboxes', () => mocks.mailboxes);
vi.mock('@voicespark/core/services/hub/ignore-rules', () => mocks.ignoreRules);
vi.mock('@voicespark/core/services/hub/sources', () => mocks.sources);

const user = { userId: 'u1', role: 'user' as const };
const SOURCE = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const PERSON = '44444444-4444-4444-8444-444444444444';

const noParams = { params: Promise.resolve({}) };
const sourceParams = { params: Promise.resolve({ sourceId: SOURCE }) };

function req(method: string, body?: unknown, url = 'http://x/api/hub/mailboxes'): Request {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

const notFound = () => new AppError('not_found', undefined, undefined, 404);

const mailbox = {
  sourceId: SOURCE,
  accountLabel: 'me@owner.example',
  status: 'connected',
  enabled: true,
  enabledAt: '2026-10-01T10:00:00.000Z',
  backfillState: 'pending',
  pausedUntil: null,
  threadsProcessed: 4,
  threadsSkipped: 2,
  threadsFailed: 1,
  lastRunAt: null,
  dataChoice: null,
  failedThreads: [
    {
      id: THREAD,
      subjectAvailable: false,
      errorCode: 'llm_refused',
      attempts: 8,
      lastAttemptAt: '2026-10-02T10:00:00.000Z',
    },
  ],
};

const MAILBOX_KEYS = [
  'sourceId',
  'accountLabel',
  'status',
  'enabled',
  'enabledAt',
  'backfillState',
  'pausedUntil',
  'threadsProcessed',
  'threadsSkipped',
  'threadsFailed',
  'lastRunAt',
  'dataChoice',
  'failedThreads',
].sort();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue(user);
});

describe('GET /api/hub/mailboxes', () => {
  it('returns {items} in the contract shape; failed threads carry no subject', async () => {
    mocks.mailboxes.list.mockResolvedValue([mailbox]);
    const res = await mailboxesRoute.GET(req('GET'), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [mailbox] });
    expect(Object.keys(body.items[0]).sort()).toEqual(MAILBOX_KEYS);
    expect(body.items[0].failedThreads[0].subjectAvailable).toBe(false);
    expect(Object.keys(body.items[0].failedThreads[0]).sort()).toEqual(
      ['id', 'subjectAvailable', 'errorCode', 'attempts', 'lastAttemptAt'].sort(),
    );
    expect(mocks.mailboxes.list).toHaveBeenCalledWith(user);
  });

  it('returns 401 when unauthenticated', async () => {
    mocks.requireUser.mockRejectedValueOnce(new AppError('unauthenticated'));
    expect((await mailboxesRoute.GET(req('GET'), noParams)).status).toBe(401);
    expect(mocks.mailboxes.list).not.toHaveBeenCalled();
  });
});

describe('POST /api/hub/mailboxes/{sourceId}/enable', () => {
  it('passes the body to the service and returns {mailbox}', async () => {
    mocks.mailboxes.enable.mockResolvedValue(mailbox);
    const res = await enableRoute.POST(req('POST', { acknowledgeAi: true }), sourceParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mailbox });
    expect(mocks.mailboxes.enable).toHaveBeenCalledWith(user, SOURCE, { acknowledgeAi: true });
    expect(mocks.rateLimit).toHaveBeenCalledWith(`hub-mailboxes:${user.userId}`, expect.any(Number), expect.any(Number));
  });

  it('answers 422 without the acknowledgement and 409 conflict when already enabled', async () => {
    mocks.mailboxes.enable.mockRejectedValueOnce(
      new AppError('validation_failed', undefined, { fields: ['acknowledgeAi'] }),
    );
    const bad = await enableRoute.POST(req('POST', {}), sourceParams);
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe('validation_failed');
    mocks.mailboxes.enable.mockRejectedValueOnce(new AppError('conflict'));
    const dup = await enableRoute.POST(req('POST', { acknowledgeAi: true }), sourceParams);
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe('conflict');
    expect(mocks.auditForeignAccess).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON with 422 before the service', async () => {
    const res = await enableRoute.POST(
      new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }),
      sourceParams,
    );
    expect(res.status).toBe(422);
    expect(mocks.mailboxes.enable).not.toHaveBeenCalled();
  });

  it('answers 404 for a foreign source and audits the access', async () => {
    mocks.mailboxes.enable.mockRejectedValueOnce(notFound());
    const res = await enableRoute.POST(req('POST', { acknowledgeAi: true }), sourceParams);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'source', SOURCE);
  });
});

describe('POST /api/hub/mailboxes/{sourceId}/disable', () => {
  it('returns {mailbox, deletionRequestId}', async () => {
    const off = { ...mailbox, enabled: false, dataChoice: 'delete' };
    mocks.mailboxes.disable.mockResolvedValue({ mailbox: off, deletionRequestId: RULE });
    const res = await disableRoute.POST(req('POST', { hubData: 'delete' }), sourceParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mailbox: off, deletionRequestId: RULE });
    expect(mocks.mailboxes.disable).toHaveBeenCalledWith(user, SOURCE, { hubData: 'delete' });
  });

  it('answers 409 hub_not_enabled, 422 for a missing choice and 404 + audit for a foreign source', async () => {
    mocks.mailboxes.disable.mockRejectedValueOnce(new AppError('hub_not_enabled'));
    const off = await disableRoute.POST(req('POST', { hubData: 'keep' }), sourceParams);
    expect(off.status).toBe(409);
    expect(await errorCode(off)).toBe('hub_not_enabled');
    mocks.mailboxes.disable.mockRejectedValueOnce(
      new AppError('validation_failed', undefined, { fields: ['hubData'] }),
    );
    expect((await disableRoute.POST(req('POST', {}), sourceParams)).status).toBe(422);
    mocks.mailboxes.disable.mockRejectedValueOnce(notFound());
    expect((await disableRoute.POST(req('POST', { hubData: 'keep' }), sourceParams)).status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'source', SOURCE);
  });
});

describe('POST /api/hub/mailboxes/{sourceId}/threads/{threadId}/retry', () => {
  const params = { params: Promise.resolve({ sourceId: SOURCE, threadId: THREAD }) };

  it('returns 202 with an empty body', async () => {
    mocks.mailboxes.retryThread.mockResolvedValue(undefined);
    const res = await retryRoute.POST(req('POST'), params);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
    expect(mocks.mailboxes.retryThread).toHaveBeenCalledWith(user, SOURCE, THREAD);
  });

  it('answers 409 conflict for a thread that is not failed', async () => {
    mocks.mailboxes.retryThread.mockRejectedValueOnce(new AppError('conflict'));
    const res = await retryRoute.POST(req('POST'), params);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
  });

  it('answers 404 for a foreign source or thread and audits both ids', async () => {
    mocks.mailboxes.retryThread.mockRejectedValueOnce(notFound());
    const res = await retryRoute.POST(req('POST'), params);
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'source', SOURCE);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_thread', THREAD);
  });
});

describe('/api/hub/ignore-rules', () => {
  const rule = { id: RULE, kind: 'domain', value: 'news.example', createdAt: '2026-10-01T10:00:00.000Z' };

  it('GET returns {items}', async () => {
    mocks.ignoreRules.list.mockResolvedValue([rule]);
    const res = await ignoreRulesRoute.GET(req('GET'), noParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [rule] });
    expect(Object.keys(body.items[0]).sort()).toEqual(['createdAt', 'id', 'kind', 'value']);
  });

  it('POST returns 201 {rule}', async () => {
    mocks.ignoreRules.create.mockResolvedValue(rule);
    const res = await ignoreRulesRoute.POST(req('POST', { kind: 'domain', value: 'News.Example' }), noParams);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ rule });
    expect(mocks.ignoreRules.create).toHaveBeenCalledWith(user, { kind: 'domain', value: 'News.Example' });
    expect(mocks.rateLimit).toHaveBeenCalledWith(`hub-ignore-rules:${user.userId}`, expect.any(Number), expect.any(Number));
  });

  it('POST answers 409 conflict for an existing rule and 422 for a bad value', async () => {
    mocks.ignoreRules.create.mockRejectedValueOnce(new AppError('conflict'));
    const dup = await ignoreRulesRoute.POST(req('POST', { kind: 'address', value: 'a@b.example' }), noParams);
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe('conflict');
    mocks.ignoreRules.create.mockRejectedValueOnce(
      new AppError('validation_failed', undefined, { fields: ['value'] }),
    );
    const bad = await ignoreRulesRoute.POST(req('POST', { kind: 'address', value: 'nope' }), noParams);
    expect(bad.status).toBe(422);
    expect(await errorCode(bad)).toBe('validation_failed');
  });

  it('DELETE returns 204', async () => {
    mocks.ignoreRules.remove.mockResolvedValue(undefined);
    const res = await ignoreRuleIdRoute.DELETE(req('DELETE'), { params: Promise.resolve({ id: RULE }) });
    expect(res.status).toBe(204);
    expect(mocks.ignoreRules.remove).toHaveBeenCalledWith(user, RULE);
  });

  it('DELETE answers 404 for a foreign rule and audits the access', async () => {
    mocks.ignoreRules.remove.mockRejectedValueOnce(notFound());
    const res = await ignoreRuleIdRoute.DELETE(req('DELETE'), { params: Promise.resolve({ id: RULE }) });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_ignore_rule', RULE);
  });
});

describe('GET /api/hub/{kind}/{id}/sources', () => {
  const item = {
    threadId: THREAD,
    subject: 'Kickoff',
    firstMessageAt: '2026-09-01T08:00:00.000Z',
    lastMessageAt: '2026-10-02T10:00:00.000Z',
    messageCount: 3,
    participants: [{ name: 'Jan Kowalski', address: 'jan@acme.example', owner: false }],
    summary: 'Jan proposes a kickoff.',
    openUrl: null,
    supports: [{ field: 'roleTitle' }, { email: 'jan@acme.example' }],
  };

  it('maps the kind segment and returns {items}', async () => {
    mocks.sources.sourcesForRecord.mockResolvedValue({ items: [item] });
    const res = await sourcesRoute.GET(req('GET'), { params: Promise.resolve({ kind: 'people', id: PERSON }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [item] });
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'threadId',
        'subject',
        'firstMessageAt',
        'lastMessageAt',
        'messageCount',
        'participants',
        'summary',
        'openUrl',
        'supports',
      ].sort(),
    );
    expect(mocks.sources.sourcesForRecord).toHaveBeenCalledWith(user, 'person', PERSON);
  });

  it('answers 404 for an unknown kind without calling the service', async () => {
    const res = await sourcesRoute.GET(req('GET'), { params: Promise.resolve({ kind: 'notes', id: PERSON }) });
    expect(res.status).toBe(404);
    expect(mocks.sources.sourcesForRecord).not.toHaveBeenCalled();
  });

  it('answers 404 for a foreign record and audits the access', async () => {
    mocks.sources.sourcesForRecord.mockRejectedValueOnce(notFound());
    const res = await sourcesRoute.GET(req('GET'), { params: Promise.resolve({ kind: 'companies', id: PERSON }) });
    expect(res.status).toBe(404);
    expect(mocks.auditForeignAccess).toHaveBeenCalledWith(user, 'hub_company', PERSON);
  });
});

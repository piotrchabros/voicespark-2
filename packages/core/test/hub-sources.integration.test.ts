import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { encrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import * as links from '@voicespark/core/services/hub/links';
import * as records from '@voicespark/core/services/hub/records';
import { sourcesForRecord } from '@voicespark/core/services/hub/sources';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US3 sources display (T124; contracts/http-api.md "GET /api/hub/{kind}/{id}/sources", data-model.md "hub_fact",
// "hub_thread_record", "hub_thread_source"; FR-018, FR-019). Threads come from `applied` or `overridden` facts of the
// record and from the summaries attached through `hub_thread_record`.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const enc = (s: string) => encrypt('user-content', s);

async function expectCode(p: Promise<unknown>, code: string, status?: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status !== undefined) expect((err as AppError).status).toBe(status);
}

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function newCtx(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

async function newSource(userId: string, type: 'gmail' | 'imap'): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into connected_source (user_id, type, account_label, account_address, status, consent_text_version)
     values ($1, $2, 'me@owner.example', 'me@owner.example', 'connected', 'v1') returning id`,
    [userId, type],
  );
  return r!.id;
}

const PARTICIPANTS = [
  {
    address: 'jan@acme.example',
    name: 'Jan Kowalski',
    roles: ['from'],
    sent: true,
    owner: false,
    automated: false,
    roleAddress: false,
    freeMail: false,
  },
  {
    address: 'me@owner.example',
    name: null,
    roles: ['to'],
    sent: false,
    owner: true,
    automated: false,
    roleAddress: false,
    freeMail: false,
  },
];

async function newThread(
  userId: string,
  opts: { subject: string; summary: string | null; last: string; sourceId?: string; webLink?: string | null },
): Promise<string> {
  const [t] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, subject_enc, participants_enc, first_message_at, last_message_at,
                             message_count, summary_enc, status, processed_version)
     values ($1, $2, $3, $4, '2026-09-01T08:00:00Z', $5, 3, $6, 'done', 1) returning id`,
    [
      userId,
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
      enc(opts.subject),
      enc(JSON.stringify(PARTICIPANTS)),
      opts.last,
      opts.summary === null ? null : enc(opts.summary),
    ],
  );
  if (opts.sourceId) {
    await q('insert into hub_thread_source (user_id, thread_id, source_id, web_link_enc) values ($1, $2, $3, $4)', [
      userId,
      t!.id,
      opts.sourceId,
      opts.webLink ? enc(opts.webLink) : null,
    ]);
  }
  return t!.id;
}

async function newFact(
  userId: string,
  threadId: string | null,
  f: {
    type: string;
    state: string;
    personId?: string;
    companyId?: string;
    linkId?: string;
    field?: string | null;
    value?: unknown;
  },
): Promise<void> {
  await q(
    `insert into hub_fact (user_id, thread_id, type, state, person_id, company_id, link_id, field, value_enc,
                           confidence, fingerprint, reason, policy_version, prompt_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0.9, $10, $11, 'v1', 'p1')`,
    [
      userId,
      threadId,
      f.type,
      f.state,
      f.personId ?? null,
      f.companyId ?? null,
      f.linkId ?? null,
      f.field ?? null,
      f.value === undefined ? null : enc(JSON.stringify(f.value)),
      randomUUID().replace(/-/g, '').padEnd(64, '0'),
      f.state === 'suggested' ? 'low_confidence' : null,
    ],
  );
}

async function attach(userId: string, threadId: string, rec: { personId?: string; companyId?: string }) {
  await q('insert into hub_thread_record (user_id, thread_id, person_id, company_id) values ($1, $2, $3, $4)', [
    userId,
    threadId,
    rec.personId ?? null,
    rec.companyId ?? null,
  ]);
}

async function world() {
  const ctx = await newCtx();
  const personId = (await records.create(ctx, 'person', { name: 'Jan Kowalski' })).record.id;
  const companyId = (await records.create(ctx, 'company', { name: 'Acme' })).record.id;
  const linkId = (await links.create(ctx, { kind: 'person_company', personId, companyId })).link.id;
  const gmail = await newSource(ctx.userId, 'gmail');
  const imap = await newSource(ctx.userId, 'imap');
  return { ctx, personId, companyId, linkId, gmail, imap };
}

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('sourcesForRecord', () => {
  it('returns fact threads and attached summaries newest first, with supports, participants and openUrl', async () => {
    const w = await world();
    const { userId } = w.ctx;
    const factThread = await newThread(userId, {
      subject: 'Kickoff',
      summary: 'Jan proposes a kickoff.',
      last: '2026-10-02T10:00:00Z',
      sourceId: w.gmail,
      webLink: 'https://mail.google.com/mail/#all/abc',
    });
    await newFact(userId, factThread, { type: 'field', state: 'applied', personId: w.personId, field: 'roleTitle', value: 'CTO' });
    await newFact(userId, factThread, { type: 'field', state: 'overridden', personId: w.personId, field: 'phone', value: '+48 600' });
    await newFact(userId, factThread, {
      type: 'person_email',
      state: 'applied',
      personId: w.personId,
      value: { address: 'jan@acme.example' },
    });
    await newFact(userId, factThread, {
      type: 'link',
      state: 'applied',
      personId: w.personId,
      companyId: w.companyId,
      linkId: w.linkId,
    });
    await attach(userId, factThread, { personId: w.personId });

    const summaryThread = await newThread(userId, {
      subject: 'Invoice',
      summary: 'Payment terms agreed.',
      last: '2026-10-05T10:00:00Z',
      sourceId: w.imap,
      webLink: null,
    });
    await attach(userId, summaryThread, { personId: w.personId });

    // Not shown: a suggestion, a superseded value, a fact with no thread, another record's thread.
    const suggested = await newThread(userId, { subject: 'Maybe', summary: null, last: '2026-10-07T10:00:00Z' });
    await newFact(userId, suggested, { type: 'field', state: 'suggested', personId: w.personId, field: 'roleTitle', value: 'CEO' });
    await newFact(userId, suggested, { type: 'field', state: 'superseded', personId: w.personId, field: 'roleTitle', value: 'VP' });
    await newFact(userId, null, { type: 'field', state: 'applied', personId: w.personId, field: 'industry', value: 'x' });
    const companyOnly = await newThread(userId, { subject: 'Acme news', summary: 'Acme moved.', last: '2026-10-08T10:00:00Z' });
    await attach(userId, companyOnly, { companyId: w.companyId });

    const { items } = await sourcesForRecord(w.ctx, 'person', w.personId);
    expect(items.map((i) => i.threadId)).toEqual([summaryThread, factThread]);

    const [summary, facts] = items;
    expect(summary).toEqual({
      threadId: summaryThread,
      subject: 'Invoice',
      firstMessageAt: '2026-09-01T08:00:00.000Z',
      lastMessageAt: '2026-10-05T10:00:00.000Z',
      messageCount: 3,
      participants: [
        { name: 'Jan Kowalski', address: 'jan@acme.example', owner: false },
        { name: null, address: 'me@owner.example', owner: true },
      ],
      summary: 'Payment terms agreed.',
      openUrl: null,
      supports: [],
    });
    expect(facts!.openUrl).toBe('https://mail.google.com/mail/#all/abc');
    expect(facts!.summary).toBe('Jan proposes a kickoff.');
    expect(facts!.supports).toEqual([
      { field: 'roleTitle' },
      { field: 'phone' },
      { email: 'jan@acme.example' },
      { link: w.linkId },
    ]);

    // The company sees the link fact thread and its own attached summary.
    const company = await sourcesForRecord(w.ctx, 'company', w.companyId);
    expect(company.items.map((i) => i.threadId)).toEqual([companyOnly, factThread]);
    expect(company.items[1]!.supports).toEqual([{ link: w.linkId }]);
  });

  it('lists company domain facts as domain supports', async () => {
    const w = await world();
    const t = await newThread(w.ctx.userId, { subject: 'Hi', summary: null, last: '2026-10-01T10:00:00Z' });
    await newFact(w.ctx.userId, t, { type: 'company_domain', state: 'applied', companyId: w.companyId, value: { domain: 'acme.example' } });
    const { items } = await sourcesForRecord(w.ctx, 'company', w.companyId);
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toBeNull();
    expect(items[0]!.supports).toEqual([{ domain: 'acme.example' }]);
  });

  it('person and company creation facts also support the address and domain they were created with', async () => {
    const w = await world();
    const t = await newThread(w.ctx.userId, { subject: 'Intro', summary: null, last: '2026-10-01T10:00:00Z' });
    await newFact(w.ctx.userId, t, { type: 'person', state: 'applied', personId: w.personId, value: { name: 'Jan', email: 'Jan@Acme.example' } });
    await newFact(w.ctx.userId, t, { type: 'person_email', state: 'applied', personId: w.personId, value: { address: 'jan@acme.example' } });
    await newFact(w.ctx.userId, t, { type: 'company', state: 'applied', companyId: w.companyId, value: { name: 'Acme', domain: 'acme.example' } });
    const person = await sourcesForRecord(w.ctx, 'person', w.personId);
    expect(person.items[0]!.supports).toEqual([{ field: 'name' }, { email: 'jan@acme.example' }]);
    const company = await sourcesForRecord(w.ctx, 'company', w.companyId);
    expect(company.items[0]!.supports).toEqual([{ field: 'name' }, { domain: 'acme.example' }]);
  });

  it('returns an empty list for a record without conversations', async () => {
    const w = await world();
    expect(await sourcesForRecord(w.ctx, 'person', w.personId)).toEqual({ items: [] });
  });

  it("answers 404 for another user's record, a wrong kind and a malformed id", async () => {
    const w = await world();
    const t = await newThread(w.ctx.userId, { subject: 'Secret', summary: 'Secret summary', last: '2026-10-01T10:00:00Z' });
    await attach(w.ctx.userId, t, { personId: w.personId });
    const intruder = await newCtx();
    await expectCode(sourcesForRecord(intruder, 'person', w.personId), 'not_found', 404);
    await expectCode(sourcesForRecord(w.ctx, 'company', w.personId), 'not_found', 404);
    await expectCode(sourcesForRecord(w.ctx, 'person', 'nope'), 'not_found', 404);
  });
});

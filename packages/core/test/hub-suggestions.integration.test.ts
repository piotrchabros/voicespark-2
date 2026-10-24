import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt, encrypt, hmacHex } from '@voicespark/core/crypto';
import type { ServiceContext } from '@voicespark/core/errors';
import { markerKey } from '@voicespark/core/hub/fingerprint';
import * as records from '@voicespark/core/services/hub/records';
import * as suggestions from '@voicespark/core/services/hub/suggestions';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US4 suggestion queue (T133; contracts/http-api.md "Suggestions", data-model.md "hub_fact" state machine;
// FR-015, FR-017, FR-023, FR-024). Facts are seeded with raw SQL the way the apply step stores them: `value_enc`
// holds the draft value as JSON, a suggestion that needs a record still to be created carries `depends_on_fact_id`.
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
const dec = (blob: string) => decrypt('user-content', blob);

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function newCtx(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

async function newThread(userId: string, subject: string, first = '2026-09-01T09:00:00Z', last = '2026-09-02T09:00:00Z') {
  const [t] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, subject_enc, status, version, processed_version,
                             first_message_at, last_message_at, message_count)
     values ($1, $2, $3, 'done', 1, 1, $4, $5, 2) returning id`,
    [userId, hmacHex(`t:${randomUUID()}`), enc(subject), first, last],
  );
  return t!.id;
}

interface FactSeed {
  type: string;
  state?: string;
  threadId?: string | null;
  personId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  linkId?: string | null;
  dependsOn?: string | null;
  field?: string | null;
  value: unknown;
  previous?: unknown;
  conflict?: boolean;
  confidence?: number;
  evidence?: string | null;
  reason?: string | null;
  createdAt?: string;
}

async function seedFact(userId: string, f: FactSeed): Promise<{ id: string; fingerprint: string }> {
  const state = f.state ?? 'suggested';
  const fingerprint = hmacHex(`fp:${randomUUID()}`);
  const [row] = await q<{ id: string }>(
    `insert into hub_fact (user_id, thread_id, type, state, basis, person_id, company_id, project_id, link_id,
                           depends_on_fact_id, field, value_enc, previous_value_enc, conflict, confidence,
                           evidence_enc, fingerprint, reason, policy_version, prompt_version, created_at)
     values ($1, $2, $3, $4, 'signature', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '1',
             'hub-extract-v1', coalesce($18::timestamptz, now())) returning id`,
    [
      userId,
      f.threadId ?? null,
      f.type,
      state,
      f.personId ?? null,
      f.companyId ?? null,
      f.projectId ?? null,
      f.linkId ?? null,
      f.dependsOn ?? null,
      f.field ?? null,
      enc(JSON.stringify(f.value)),
      f.previous === undefined || f.previous === null ? null : enc(JSON.stringify(f.previous)),
      f.conflict ?? false,
      f.confidence ?? 0.74,
      f.evidence ? enc(f.evidence) : null,
      fingerprint,
      state === 'suggested' ? (f.reason ?? 'low_confidence') : (f.reason ?? null),
      f.createdAt ?? null,
    ],
  );
  return { id: row!.id, fingerprint };
}

const factRow = async (id: string) =>
  (
    await q<{
      state: string;
      decided_at: Date | null;
      person_id: string | null;
      company_id: string | null;
      project_id: string | null;
      link_id: string | null;
    }>('select * from hub_fact where id = $1', [id])
  )[0]!;

const hasMarker = async (userId: string, keyHash: string) =>
  (await q('select 1 from hub_block_marker where user_id = $1 and key_hash = $2', [userId, keyHash])).length > 0;

const markerReason = async (userId: string, keyHash: string) =>
  (await q<{ reason: string }>('select reason from hub_block_marker where user_id = $1 and key_hash = $2', [userId, keyHash]))[0]
    ?.reason;

const addMarker = (userId: string, keyHash: string, reason = 'deleted') =>
  q('insert into hub_block_marker (user_id, key_hash, reason) values ($1, $2, $3)', [userId, keyHash, reason]);

const bulkAudits = (userId: string) =>
  q<{ metadata: Record<string, number> }>(
    `select metadata from audit_log_entry where actor_user_id = $1 and action = 'hub.suggestions_bulk_decided'
     order by occurred_at`,
    [userId],
  );

const person = async (ctx: ServiceContext, input: records.PersonInput) => (await records.create(ctx, 'person', input)).record;
const company = async (ctx: ServiceContext, input: records.CompanyInput) => (await records.create(ctx, 'company', input)).record;

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('suggestions.list', () => {
  it('returns the contract item shape, newest first, with sources and evidence; paginates by cursor', async () => {
    const ctx = await newCtx();
    const jan = await person(ctx, { name: 'Jan Kowalski', roleTitle: 'CTO' });
    const thread = await newThread(ctx.userId, 'Kickoff next week');
    const extra = await newThread(ctx.userId, 'Re: Kickoff', '2026-09-03T09:00:00Z', '2026-09-04T09:00:00Z');
    const older = await seedFact(ctx.userId, {
      type: 'field',
      threadId: thread,
      personId: jan.id,
      field: 'roleTitle',
      value: { field: 'roleTitle', value: 'CEO' },
      previous: 'CTO',
      conflict: true,
      reason: 'conflict',
      confidence: 0.74,
      evidence: 'Signature: Jan Kowalski, CEO',
      createdAt: '2026-09-02T10:00:00Z',
    });
    await q('insert into hub_fact_evidence (fact_id, thread_id, user_id) values ($1, $2, $3)', [older.id, extra, ctx.userId]);
    const newer = await seedFact(ctx.userId, {
      type: 'person',
      threadId: thread,
      value: { name: 'Anna Nowak', email: 'anna@acme.example' },
      confidence: 0.72,
      evidence: 'Anna Nowak <anna@acme.example>',
      createdAt: '2026-09-02T11:00:00Z',
    });
    // Not suggestions: never listed.
    await seedFact(ctx.userId, { type: 'field', state: 'applied', personId: jan.id, field: 'phone', value: { field: 'phone', value: '1' } });
    await seedFact(ctx.userId, { type: 'field', state: 'rejected', personId: jan.id, field: 'phone', value: { field: 'phone', value: '2' } });

    const page = await suggestions.list(ctx, {});
    expect(page.items.map((i) => i.id)).toEqual([newer.id, older.id]);
    expect(page.nextCursor).toBeNull();

    const item = page.items[1]!;
    expect(Object.keys(item).sort()).toEqual(
      ['id', 'type', 'target', 'field', 'proposed', 'current', 'conflict', 'reason', 'confidence', 'dependsOn', 'sources', 'createdAt'].sort(),
    );
    expect(item).toMatchObject({
      type: 'field',
      target: { kind: 'person', id: jan.id, label: 'Jan Kowalski' },
      field: 'roleTitle',
      proposed: 'CEO',
      current: 'CTO',
      conflict: true,
      reason: 'conflict',
      dependsOn: null,
      createdAt: '2026-09-02T10:00:00.000Z',
    });
    expect(item.confidence).toBeCloseTo(0.74, 5);
    expect(item.sources).toHaveLength(2);
    expect(item.sources[0]).toEqual({
      threadId: thread,
      subject: 'Kickoff next week',
      firstMessageAt: '2026-09-01T09:00:00.000Z',
      lastMessageAt: '2026-09-02T09:00:00.000Z',
      evidence: 'Signature: Jan Kowalski, CEO',
    });
    expect(item.sources[1]).toMatchObject({ threadId: extra, subject: 'Re: Kickoff' });

    const create = page.items[0]!;
    expect(create).toMatchObject({
      type: 'person',
      target: { kind: 'person', id: null },
      field: null,
      proposed: { name: 'Anna Nowak', email: 'anna@acme.example' },
      current: null,
      conflict: false,
      reason: 'low_confidence',
    });

    const first = await suggestions.list(ctx, { limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([newer.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await suggestions.list(ctx, { limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.id)).toEqual([older.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects an invalid cursor or limit with 422', async () => {
    const ctx = await newCtx();
    await expect(suggestions.list(ctx, { cursor: 'nope' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(suggestions.list(ctx, { limit: 0 })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(suggestions.list(ctx, { limit: 101 })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('suggestions.count', () => {
  it('equals the number of suggested facts and has a partial index behind it (FR-024)', async () => {
    const ctx = await newCtx();
    const jan = await person(ctx, { name: 'Jan Kowalski' });
    expect(await suggestions.count(ctx)).toEqual({ pending: 0 });
    for (let i = 0; i < 3; i++) {
      await seedFact(ctx.userId, { type: 'person_email', personId: jan.id, value: { address: `jan${i}@acme.example` } });
    }
    await seedFact(ctx.userId, { type: 'person_email', state: 'applied', personId: jan.id, value: { address: 'x@acme.example' } });
    expect(await suggestions.count(ctx)).toEqual({ pending: 3 });
    expect((await suggestions.list(ctx, {})).items).toHaveLength(3);
    const [idx] = await q<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'hub_fact' and indexname = 'hub_fact_user_suggested_created_idx'`,
      [],
    );
    expect(idx?.indexdef).toMatch(/WHERE \(state = 'suggested'/);
  });
});

describe('suggestions.decide accept', () => {
  it('writes the change, adds a conflict field to ownerFields, removes matching markers and sets decided_at', async () => {
    const ctx = await newCtx();
    const jan = await person(ctx, { name: 'Jan Kowalski' });
    const f = await seedFact(ctx.userId, {
      type: 'field',
      personId: jan.id,
      field: 'phone',
      value: { field: 'phone', value: '+48 602 345 678' },
      previous: null,
      conflict: true,
      reason: 'tombstoned',
    });
    await addMarker(ctx.userId, markerKey.field('person', jan.id, 'phone', '+48 602 345 678'));
    await addMarker(ctx.userId, markerKey.fact(f.fingerprint), 'rejected');

    const res = await suggestions.decide(ctx, { ids: [f.id], action: 'accept' });
    expect(res).toEqual({ results: [{ id: f.id, status: 'accepted' }] });

    const [p] = await q<{ phone_enc: string; owner_fields: string[] }>('select * from hub_person where id = $1', [jan.id]);
    expect(dec(p!.phone_enc)).toBe('+48 602 345 678');
    expect(p!.owner_fields).toContain('phone');
    const row = await factRow(f.id);
    expect(row.state).toBe('applied');
    expect(row.decided_at).not.toBeNull();
    expect(await hasMarker(ctx.userId, markerKey.field('person', jan.id, 'phone', '+48 602 345 678'))).toBe(false);
    expect(await hasMarker(ctx.userId, markerKey.fact(f.fingerprint))).toBe(false);
    expect(await suggestions.count(ctx)).toEqual({ pending: 0 });
    expect((await bulkAudits(ctx.userId)).map((a) => a.metadata)).toEqual([{ accepted: 1, rejected: 0, failed: 0 }]);
  });

  it('runs in dependency order: the record a suggestion depends on is created first', async () => {
    const ctx = await newCtx();
    const acme = await company(ctx, { name: 'Acme' });
    const thread = await newThread(ctx.userId, 'Intro');
    const anna = await seedFact(ctx.userId, {
      type: 'person',
      threadId: thread,
      value: { name: 'Anna Nowak', email: 'anna@acme.example' },
    });
    const role = await seedFact(ctx.userId, {
      type: 'field',
      threadId: thread,
      dependsOn: anna.id,
      field: 'roleTitle',
      value: { field: 'roleTitle', value: 'CFO' },
    });
    const link = await seedFact(ctx.userId, {
      type: 'link',
      threadId: thread,
      companyId: acme.id,
      dependsOn: anna.id,
      value: { kind: 'person_company', role: 'Finance lead' },
    });
    expect((await suggestions.list(ctx, {})).items.find((i) => i.id === link.id)?.dependsOn).toBe(anna.id);

    // The dependents only: the dependency is applied first within their decision.
    const res = await suggestions.decide(ctx, { ids: [link.id, role.id], action: 'accept' });
    expect(res.results).toEqual(
      expect.arrayContaining([
        { id: link.id, status: 'accepted' },
        { id: role.id, status: 'accepted' },
      ]),
    );
    const people = await q<{ id: string; name_enc: string; role_title_enc: string | null; created_from: string }>(
      'select * from hub_person where user_id = $1',
      [ctx.userId],
    );
    expect(people).toHaveLength(1);
    expect(dec(people[0]!.name_enc)).toBe('Anna Nowak');
    expect(dec(people[0]!.role_title_enc!)).toBe('CFO');
    const emails = await q<{ address_enc: string }>('select address_enc from hub_person_email where person_id = $1', [people[0]!.id]);
    expect(emails.map((e) => dec(e.address_enc))).toEqual(['anna@acme.example']);
    const links = await q<{ id: string; role_enc: string | null }>(
      'select * from hub_link where person_id = $1 and company_id = $2',
      [people[0]!.id, acme.id],
    );
    expect(links).toHaveLength(1);
    expect(dec(links[0]!.role_enc!)).toBe('Finance lead');

    expect(await factRow(anna.id)).toMatchObject({ state: 'applied', person_id: people[0]!.id });
    expect(await factRow(role.id)).toMatchObject({ state: 'applied', person_id: people[0]!.id });
    expect(await factRow(link.id)).toMatchObject({ state: 'applied', link_id: links[0]!.id });
    expect(await q('select 1 from hub_thread_record where thread_id = $1 and person_id = $2', [thread, people[0]!.id])).toHaveLength(1);
  });
});

describe('suggestions.decide reject', () => {
  it('sets rejected and writes the fact marker plus the type key of each kind of fact (FR-017)', async () => {
    const ctx = await newCtx();
    const jan = await person(ctx, { name: 'Jan Kowalski' });
    const acme = await company(ctx, { name: 'Acme' });
    const cases: { seed: FactSeed; key: string }[] = [
      {
        seed: { type: 'person_email', personId: jan.id, value: { address: 'Jan2@Acme.example' } },
        key: markerKey.personEmail('jan2@acme.example'),
      },
      {
        seed: { type: 'company_domain', companyId: acme.id, value: { domain: 'acme-group.example' } },
        key: markerKey.companyDomain('acme-group.example'),
      },
      { seed: { type: 'company', value: { name: 'Globex', domain: null, website: null } }, key: markerKey.companyName('Globex') },
      {
        seed: { type: 'project', value: { name: 'Rollout 2027', description: null, status: null } },
        key: markerKey.projectName('Rollout 2027'),
      },
      {
        seed: { type: 'link', personId: jan.id, companyId: acme.id, value: { kind: 'person_company', role: null } },
        key: markerKey.link('person_company', jan.id, acme.id),
      },
      {
        seed: { type: 'field', personId: jan.id, field: 'roleTitle', value: { field: 'roleTitle', value: 'CEO' } },
        key: markerKey.field('person', jan.id, 'roleTitle', 'CEO'),
      },
      {
        seed: { type: 'person', value: { name: 'Ola', email: 'ola@acme.example' } },
        key: markerKey.personEmail('ola@acme.example'),
      },
    ];
    const facts = [];
    for (const c of cases) facts.push(await seedFact(ctx.userId, c.seed));

    const res = await suggestions.decide(ctx, { ids: facts.map((f) => f.id), action: 'reject' });
    expect(res.results).toEqual(facts.map((f) => ({ id: f.id, status: 'rejected' })));
    for (const [i, f] of facts.entries()) {
      const row = await factRow(f.id);
      expect(row.state, cases[i]!.seed.type).toBe('rejected');
      expect(row.decided_at).not.toBeNull();
      expect(await markerReason(ctx.userId, markerKey.fact(f.fingerprint)), cases[i]!.seed.type).toBe('rejected');
      expect(await markerReason(ctx.userId, cases[i]!.key), cases[i]!.seed.type).toBe('rejected');
    }
    // Nothing was written to the records.
    expect(await q('select 1 from hub_person_email where person_id = $1', [jan.id])).toHaveLength(0);
    expect(await q('select 1 from hub_link where person_id = $1', [jan.id])).toHaveLength(0);
    expect((await bulkAudits(ctx.userId)).map((a) => a.metadata)).toEqual([{ accepted: 0, rejected: 7, failed: 0 }]);
  });

  it('rejects the dependents of a rejected fact without markers', async () => {
    const ctx = await newCtx();
    const anna = await seedFact(ctx.userId, { type: 'person', value: { name: 'Anna Nowak', email: 'anna@acme.example' } });
    const role = await seedFact(ctx.userId, {
      type: 'field',
      dependsOn: anna.id,
      field: 'roleTitle',
      value: { field: 'roleTitle', value: 'CFO' },
    });
    const res = await suggestions.decide(ctx, { ids: [anna.id], action: 'reject' });
    expect(res.results).toEqual([{ id: anna.id, status: 'rejected' }]);
    expect((await factRow(role.id)).state).toBe('rejected');
    expect((await factRow(role.id)).decided_at).not.toBeNull();
    expect(await hasMarker(ctx.userId, markerKey.fact(role.fingerprint))).toBe(false);
    expect(await hasMarker(ctx.userId, markerKey.fact(anna.fingerprint))).toBe(true);
    expect(await suggestions.count(ctx)).toEqual({ pending: 0 });
  });
});

describe('suggestions.decide per-id results', () => {
  it('a fact no longer suggested gives suggestion_not_pending for that id and does not fail the call', async () => {
    const ctx = await newCtx();
    const jan = await person(ctx, { name: 'Jan Kowalski' });
    const done = await seedFact(ctx.userId, {
      type: 'field',
      state: 'applied',
      personId: jan.id,
      field: 'roleTitle',
      value: { field: 'roleTitle', value: 'CTO' },
    });
    const pending = await seedFact(ctx.userId, {
      type: 'field',
      personId: jan.id,
      field: 'roleTitle',
      value: { field: 'roleTitle', value: 'CEO' },
    });
    const res = await suggestions.decide(ctx, { ids: [done.id, pending.id], action: 'accept' });
    expect(res.results).toEqual([
      { id: done.id, status: 'failed', errorCode: 'suggestion_not_pending' },
      { id: pending.id, status: 'accepted' },
    ]);
    // A second decision on the same fact.
    const again = await suggestions.decide(ctx, { ids: [pending.id], action: 'reject' });
    expect(again.results).toEqual([{ id: pending.id, status: 'failed', errorCode: 'suggestion_not_pending' }]);
    expect((await factRow(pending.id)).state).toBe('applied');
    expect((await bulkAudits(ctx.userId)).map((a) => a.metadata)).toEqual([
      { accepted: 1, rejected: 0, failed: 1 },
      { accepted: 0, rejected: 0, failed: 1 },
    ]);
  });

  it('drops a suggestion whose target record was deleted: hidden from list and count, not pending', async () => {
    const ctx = await newCtx();
    const jan = await person(ctx, { name: 'Jan Kowalski' });
    const f = await seedFact(ctx.userId, { type: 'person_email', personId: jan.id, value: { address: 'jan@acme.example' } });
    expect(await suggestions.count(ctx)).toEqual({ pending: 1 });
    await records.remove(ctx, 'person', jan.id);
    expect((await factRow(f.id)).person_id).toBeNull();
    expect((await suggestions.list(ctx, {})).items).toEqual([]);
    expect(await suggestions.count(ctx)).toEqual({ pending: 0 });
    const res = await suggestions.decide(ctx, { ids: [f.id], action: 'accept' });
    expect(res.results).toEqual([{ id: f.id, status: 'failed', errorCode: 'suggestion_not_pending' }]);
  });

  it("another user's fact is not found for that id and is left untouched (FR-015)", async () => {
    const owner = await newCtx();
    const other = await newCtx();
    const jan = await person(owner, { name: 'Jan Kowalski' });
    const f = await seedFact(owner.userId, { type: 'person_email', personId: jan.id, value: { address: 'jan@acme.example' } });
    expect((await suggestions.list(other, {})).items).toEqual([]);
    expect(await suggestions.count(other)).toEqual({ pending: 0 });
    const res = await suggestions.decide(other, { ids: [f.id], action: 'reject' });
    expect(res.results).toEqual([{ id: f.id, status: 'failed', errorCode: 'not_found' }]);
    expect((await factRow(f.id)).state).toBe('suggested');
    expect(await hasMarker(other.userId, markerKey.fact(f.fingerprint))).toBe(false);
    expect(await hasMarker(owner.userId, markerKey.fact(f.fingerprint))).toBe(false);
  });

  it('validates ids (1..200 uuids) and action with 422', async () => {
    const ctx = await newCtx();
    const bad = [
      { ids: [], action: 'accept' },
      { ids: Array.from({ length: 201 }, () => randomUUID()), action: 'accept' },
      { ids: ['not-a-uuid'], action: 'accept' },
      { ids: [randomUUID()], action: 'maybe' },
      { ids: [randomUUID()] },
    ];
    for (const input of bad) {
      await expect(suggestions.decide(ctx, input as never)).rejects.toMatchObject({ code: 'validation_failed' });
    }
    expect(await bulkAudits(ctx.userId)).toEqual([]);
  });
});

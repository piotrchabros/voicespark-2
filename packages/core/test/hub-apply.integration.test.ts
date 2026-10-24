import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { claimThread } from '@voicespark/db/repos/system/hub';
import { decrypt } from '@voicespark/core/crypto';
import type { ServiceContext } from '@voicespark/core/errors';
import type { HubExtraction } from '@voicespark/core/hub/extraction-schema';
import { applyExtraction, type ApplyContext, type ApplyParticipant } from '@voicespark/core/services/hub/apply';
import * as records from '@voicespark/core/services/hub/records';
import { addKeywordRule, cleanupProfiles, createUser } from './helpers/profiles';

// US3 apply step (T104; contracts/hub-extraction.md sections 9-11, data-model.md "hub_fact", "hub_fact_evidence",
// "hub_thread_record", "Provenance and owner_fields"; FR-015..FR-019, FR-028, SC-007). Everything runs in one
// transaction under the per-user apply lock; the policy itself is covered by hub-policy.test.ts.
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

const PROMPT_VERSION = 'hub-extract-v1';
const SECRET = 'Xk9mQ2vLp7';
const dec = (blob: string) => decrypt('user-content', blob);

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function newCtx(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

async function newSource(userId: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into connected_source (user_id, type, account_label, account_address, status, consent_text_version)
     values ($1, 'imap', 'me@owner.example', 'me@owner.example', 'connected', 'v1') returning id`,
    [userId],
  );
  await q(`insert into hub_mailbox_setting (source_id, user_id, enabled) values ($1, $2, true)`, [r!.id, userId]);
  return r!.id;
}

/** A pending thread of `sourceId`, claimed like the worker does; returns the id and the claimed version. */
async function newThread(userId: string, sourceId: string, lastMessageAt = '2026-10-01T10:00:00Z') {
  const [t] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, status, version, processed_version, next_attempt_at,
                             first_message_at, last_message_at, message_count)
     values ($1, $2, 'pending', 1, 0, now() - interval '1 second', $3, $3, 2) returning id`,
    [userId, randomUUID().replace(/-/g, '').padEnd(64, '0'), lastMessageAt],
  );
  await q('insert into hub_thread_source (user_id, thread_id, source_id) values ($1, $2, $3)', [userId, t!.id, sourceId]);
  const version = await claimThread(t!.id);
  expect(version).toBe(1);
  return { threadId: t!.id, version: version! };
}

/** Puts a processed thread back to a claimable state (a second run of the same version). */
async function reclaim(threadId: string): Promise<number> {
  await q(
    `update hub_thread set status = 'pending', processed_version = 0, next_attempt_at = now() - interval '1 second',
            locked_until = null where id = $1`,
    [threadId],
  );
  return (await claimThread(threadId))!;
}

const JAN: ApplyParticipant = {
  key: 'P1',
  address: 'jan@acme.example',
  name: 'Jan Kowalski',
  roles: ['from'],
  sent: true,
  owner: false,
  automated: false,
  roleAddress: false,
  freeMail: false,
  messagesSent: 1,
  directToOnOwnerSent: false,
};
const ME: ApplyParticipant = {
  key: 'P2',
  address: 'me@owner.example',
  name: 'Me',
  roles: ['to'],
  sent: false,
  owner: true,
  automated: false,
  roleAddress: false,
  freeMail: false,
  messagesSent: 0,
  directToOnOwnerSent: false,
};

function context(overrides: Partial<ApplyContext> = {}): ApplyContext {
  return { participants: [JAN, ME], ownerAddresses: ['me@owner.example'], promptVersion: PROMPT_VERSION, ...overrides };
}

type Person = HubExtraction['people'][number];

function person(overrides: Partial<Person> = {}): Person {
  return {
    participantKey: 'P1',
    existingPersonId: null,
    name: 'Jan Kowalski',
    isHuman: true,
    roleTitle: null,
    roleTitleBasis: null,
    phone: null,
    phoneBasis: null,
    companyRef: 'C1',
    confidence: 0.95,
    evidence: 'Signature: Jan Kowalski, Acme',
    ...overrides,
  };
}

function extraction(overrides: Partial<HubExtraction> = {}): HubExtraction {
  return {
    relevant: true,
    language: 'pl',
    summary: 'Jan from Acme proposes a kickoff meeting next week.',
    people: [person()],
    companies: [
      {
        ref: 'C1',
        existingCompanyId: null,
        name: 'Acme',
        domain: 'acme.example',
        website: null,
        industry: null,
        industryConfidence: null,
        basis: 'domain',
        confidence: 0.9,
        evidence: 'jan@acme.example',
      },
    ],
    projects: [],
    links: [
      {
        kind: 'person_company',
        from: 'P1',
        to: 'C1',
        role: null,
        roleConfidence: null,
        basis: 'signature',
        confidence: 0.9,
        evidence: 'Jan Kowalski, Acme',
      },
    ],
    ...overrides,
  };
}

const personsOf = (userId: string) =>
  q<{ id: string; name_enc: string; role_title_enc: string | null; phone_enc: string | null; created_from: string; owner_fields: string[] }>(
    'select * from hub_person where user_id = $1 order by created_at, id',
    [userId],
  );

const factsOf = (userId: string) =>
  q<{
    id: string;
    thread_id: string | null;
    type: string;
    state: string;
    reason: string | null;
    field: string | null;
    conflict: boolean;
    person_id: string | null;
    company_id: string | null;
    link_id: string | null;
    value_enc: string | null;
    previous_value_enc: string | null;
    evidence_enc: string | null;
    fingerprint: string;
    policy_version: string;
    prompt_version: string;
    depends_on_fact_id: string | null;
  }>('select * from hub_fact where user_id = $1 order by created_at, id', [userId]);

const threadOf = async (threadId: string) =>
  (
    await q<{
      status: string;
      skip_reason: string | null;
      processed_version: number;
      summary_enc: string | null;
      summary_version: number;
      language: string | null;
      participants_enc: string | null;
      locked_until: Date | null;
    }>('select *, processed_version::int as processed_version from hub_thread where id = $1', [threadId])
  )[0]!;

const syncDoc = async (userId: string, docId: string) =>
  (await q<{ status: string }>('select status from hub_sync_item where user_id = $1 and doc_id = $2', [userId, docId]))[0];

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('applyExtraction', () => {
  it('waits for the per-user apply lock and writes nothing before it is granted', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    const holder = await getPool().connect();
    try {
      await holder.query('begin');
      await holder.query(`select pg_advisory_xact_lock(hashtext('hub-apply:' || $1))`, [ctx.userId]);
      let finished = false;
      const run = applyExtraction(ctx.userId, threadId, version, extraction(), context()).then((r) => {
        finished = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(finished).toBe(false);
      expect(await personsOf(ctx.userId)).toHaveLength(0);
      await holder.query('commit');
      const result = await run;
      expect(result.outcome).toBe('done');
    } finally {
      holder.release();
    }
    expect(await personsOf(ctx.userId)).toHaveLength(1);
  });

  it('applies records, links, facts, thread records, summary, sync marks, search rows and counters', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    const result = await applyExtraction(ctx.userId, threadId, version, extraction(), context());
    expect(result).toMatchObject({ outcome: 'done', skipReason: null, summaryStored: true });

    const [p] = await personsOf(ctx.userId);
    expect(dec(p!.name_enc)).toBe('Jan Kowalski');
    expect(p!.created_from).toBe('email');
    expect(p!.owner_fields).toEqual([]);
    const [email] = await q<{ address_enc: string; origin: string; is_primary: boolean }>(
      'select * from hub_person_email where person_id = $1',
      [p!.id],
    );
    expect(dec(email!.address_enc)).toBe('jan@acme.example');
    expect(email).toMatchObject({ origin: 'email', is_primary: true });

    const [c] = await q<{ id: string; name_enc: string; created_from: string }>(
      'select * from hub_company where user_id = $1',
      [ctx.userId],
    );
    expect(dec(c!.name_enc)).toBe('Acme');
    expect(c!.created_from).toBe('email');
    const [d] = await q<{ domain_enc: string; origin: string }>('select * from hub_company_domain where company_id = $1', [c!.id]);
    expect(dec(d!.domain_enc)).toBe('acme.example');
    expect(d!.origin).toBe('email');
    const [l] = await q<{ id: string; kind: string; origin: string; person_id: string; company_id: string }>(
      'select * from hub_link where user_id = $1',
      [ctx.userId],
    );
    expect(l).toMatchObject({ kind: 'person_company', origin: 'email', person_id: p!.id, company_id: c!.id });

    const facts = await factsOf(ctx.userId);
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f).toMatchObject({ thread_id: threadId, state: 'applied', policy_version: 'hub-policy-v1', prompt_version: PROMPT_VERSION });
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    // FR-018: every email-derived value and link has a fact naming the thread.
    expect(facts.some((f) => f.type === 'person' && f.person_id === p!.id)).toBe(true);
    expect(facts.some((f) => f.type === 'company' && f.company_id === c!.id)).toBe(true);
    expect(facts.some((f) => f.type === 'company_domain' && f.company_id === c!.id)).toBe(true);
    expect(facts.some((f) => f.type === 'link' && f.link_id === l!.id)).toBe(true);

    const attached = await q<{ person_id: string | null; company_id: string | null }>(
      'select person_id, company_id from hub_thread_record where thread_id = $1',
      [threadId],
    );
    expect(attached).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ person_id: p!.id }),
        expect.objectContaining({ company_id: c!.id }),
      ]),
    );

    const t = await threadOf(threadId);
    expect(t).toMatchObject({ status: 'done', skip_reason: null, processed_version: 1, summary_version: 1, language: 'pl', locked_until: null });
    expect(dec(t.summary_enc!)).toBe('Jan from Acme proposes a kickoff meeting next week.');
    const participants = JSON.parse(dec(t.participants_enc!)) as { address: string; owner: boolean }[];
    expect(participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: 'jan@acme.example', owner: false }),
        expect.objectContaining({ address: 'me@owner.example', owner: true }),
      ]),
    );
    expect(participants[0]).not.toHaveProperty('key');

    expect(await syncDoc(ctx.userId, `hub_person_${p!.id}`)).toMatchObject({ status: 'pending' });
    expect(await syncDoc(ctx.userId, `hub_company_${c!.id}`)).toMatchObject({ status: 'pending' });
    expect(await syncDoc(ctx.userId, `hub_summary_${threadId}`)).toMatchObject({ status: 'pending' });
    const docs = await q<{ item_type: string; item_id: string }>(
      'select item_type, item_id from hub_search_doc where user_id = $1',
      [ctx.userId],
    );
    expect(docs).toEqual(
      expect.arrayContaining([
        { item_type: 'person', item_id: p!.id },
        { item_type: 'company', item_id: c!.id },
      ]),
    );

    const [m] = await q<{ threads_processed: number; threads_skipped: number; last_run_at: Date | null }>(
      'select * from hub_mailbox_setting where source_id = $1',
      [src],
    );
    expect(m).toMatchObject({ threads_processed: 1, threads_skipped: 0 });
    expect(m!.last_run_at).not.toBeNull();
  });

  it('is a no-op on a re-run of the same thread: (thread_id, fingerprint) is unique', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    const input = extraction({ people: [person({ phone: '+48 601 234 567', phoneBasis: 'signature' })] });
    await applyExtraction(ctx.userId, threadId, version, input, context());
    const before = {
      facts: (await factsOf(ctx.userId)).map((f) => f.id),
      people: (await personsOf(ctx.userId)).length,
      links: (await q('select id from hub_link where user_id = $1', [ctx.userId])).length,
      domains: (await q('select id from hub_company_domain where user_id = $1', [ctx.userId])).length,
      evidence: (await q('select * from hub_fact_evidence where user_id = $1', [ctx.userId])).length,
      attached: (await q('select id from hub_thread_record where thread_id = $1', [threadId])).length,
    };

    const again = await reclaim(threadId);
    expect((await applyExtraction(ctx.userId, threadId, again, input, context())).outcome).toBe('done');
    expect((await factsOf(ctx.userId)).map((f) => f.id)).toEqual(before.facts);
    expect((await personsOf(ctx.userId)).length).toBe(before.people);
    expect((await q('select id from hub_link where user_id = $1', [ctx.userId])).length).toBe(before.links);
    expect((await q('select id from hub_company_domain where user_id = $1', [ctx.userId])).length).toBe(before.domains);
    expect((await q('select * from hub_fact_evidence where user_id = $1', [ctx.userId])).length).toBe(before.evidence);
    expect((await q('select id from hub_thread_record where thread_id = $1', [threadId])).length).toBe(before.attached);
  });

  it('adds hub_fact_evidence when another thread corroborates an applied value', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const input = extraction({ people: [person({ phone: '+48 601 234 567', phoneBasis: 'signature' })] });
    const a = await newThread(ctx.userId, src, '2026-10-01T10:00:00Z');
    await applyExtraction(ctx.userId, a.threadId, a.version, input, context());
    const phoneFact = (await factsOf(ctx.userId)).find((f) => f.type === 'field' && f.field === 'phone');
    expect(phoneFact).toMatchObject({ state: 'applied', thread_id: a.threadId });

    const b = await newThread(ctx.userId, src, '2026-10-05T10:00:00Z');
    await applyExtraction(ctx.userId, b.threadId, b.version, input, context());
    const evidence = await q<{ fact_id: string; thread_id: string }>(
      'select fact_id, thread_id from hub_fact_evidence where user_id = $1',
      [ctx.userId],
    );
    expect(evidence).toContainEqual({ fact_id: phoneFact!.id, thread_id: b.threadId });
    const phoneFacts = (await factsOf(ctx.userId)).filter((f) => f.type === 'field' && f.field === 'phone');
    expect(phoneFacts).toHaveLength(1);
    // The corroborating thread is attached to the person too.
    const [p] = await personsOf(ctx.userId);
    expect(await q('select id from hub_thread_record where thread_id = $1 and person_id = $2', [b.threadId, p!.id])).toHaveLength(1);
  });

  it('a newer email value supersedes an older email-set value', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const a = await newThread(ctx.userId, src, '2026-09-01T10:00:00Z');
    await applyExtraction(
      ctx.userId,
      a.threadId,
      a.version,
      extraction({ people: [person({ roleTitle: 'Developer', roleTitleBasis: 'signature' })] }),
      context(),
    );
    const b = await newThread(ctx.userId, src, '2026-10-01T10:00:00Z');
    await applyExtraction(
      ctx.userId,
      b.threadId,
      b.version,
      extraction({ people: [person({ roleTitle: 'CTO', roleTitleBasis: 'signature' })] }),
      context(),
    );
    const [p] = await personsOf(ctx.userId);
    expect(dec(p!.role_title_enc!)).toBe('CTO');
    const roleFacts = (await factsOf(ctx.userId)).filter((f) => f.field === 'roleTitle');
    expect(roleFacts.find((f) => f.thread_id === a.threadId)?.state).toBe('superseded');
    expect(roleFacts.find((f) => f.thread_id === b.threadId)?.state).toBe('applied');
  });

  it('never overwrites an owner-set value: a conflict suggestion carries both values (SC-007)', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { record } = await records.create(ctx, 'person', {
      name: 'Jan Kowalski',
      phone: '+48 601 234 567',
      emails: ['jan@acme.example'],
    });
    const { threadId, version } = await newThread(ctx.userId, src);
    await applyExtraction(
      ctx.userId,
      threadId,
      version,
      extraction({ people: [person({ phone: '+48 602 345 678', phoneBasis: 'signature' })] }),
      context(),
    );
    const [p] = await personsOf(ctx.userId);
    expect(p!.id).toBe(record.id);
    expect(dec(p!.phone_enc!)).toBe('+48 601 234 567');
    const f = (await factsOf(ctx.userId)).find((x) => x.field === 'phone');
    expect(f).toMatchObject({ state: 'suggested', reason: 'conflict', conflict: true, person_id: record.id });
    expect(dec(f!.previous_value_enc!)).toContain('+48 601 234 567');
    expect(dec(f!.value_enc!)).toContain('+48 602 345 678');
  });

  it('skips as irrelevant without a summary or records when relevant = false', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    const result = await applyExtraction(ctx.userId, threadId, version, extraction({ relevant: false }), context());
    expect(result).toMatchObject({ outcome: 'skipped', skipReason: 'irrelevant', summaryStored: false });
    const t = await threadOf(threadId);
    expect(t).toMatchObject({ status: 'skipped', skip_reason: 'irrelevant', summary_enc: null, processed_version: 1 });
    expect(await personsOf(ctx.userId)).toHaveLength(0);
    expect(await factsOf(ctx.userId)).toHaveLength(0);
    const [m] = await q<{ threads_processed: number; threads_skipped: number; last_run_at: Date | null }>(
      'select * from hub_mailbox_setting where source_id = $1',
      [src],
    );
    expect(m).toMatchObject({ threads_processed: 0, threads_skipped: 1 });
    expect(m!.last_run_at).not.toBeNull();
  });

  it('skips as no_candidates when no record is attached to the thread', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    const result = await applyExtraction(
      ctx.userId,
      threadId,
      version,
      extraction({ people: [], companies: [], links: [] }),
      context(),
    );
    expect(result).toMatchObject({ outcome: 'skipped', skipReason: 'no_candidates', summaryStored: false });
    expect(await threadOf(threadId)).toMatchObject({ status: 'skipped', skip_reason: 'no_candidates', summary_enc: null });
    expect(await syncDoc(ctx.userId, `hub_summary_${threadId}`)).toBeUndefined();
  });

  it('suggestions are stored but attach nothing; dropped decisions are not stored', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    // A free-mail correspondent that never wrote: a low-confidence person suggestion, no company.
    const anna: ApplyParticipant = { ...JAN, key: 'P3', address: 'anna@gmail.example', name: 'Anna', roles: ['cc'], sent: false, messagesSent: 0 };
    const result = await applyExtraction(
      ctx.userId,
      threadId,
      version,
      extraction({
        people: [person({ participantKey: 'P3', name: 'Anna', companyRef: null, confidence: 0.75 })],
        companies: [],
        links: [],
        projects: [
          { ref: 'J1', existingProjectId: null, name: 'Projekt', description: null, status: null, explicitlyNamed: false, confidence: 0.5, evidence: '' },
        ],
      }),
      context({ participants: [anna, ME] }),
    );
    const facts = await factsOf(ctx.userId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ type: 'person', state: 'suggested', reason: 'low_confidence', person_id: null });
    expect(await personsOf(ctx.userId)).toHaveLength(0);
    expect(result).toMatchObject({ outcome: 'skipped', skipReason: 'no_candidates' });
  });

  it('resolves a merged-away id through hub_merge_redirect', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { record } = await records.create(ctx, 'person', { name: 'Jan Kowalski' });
    const gone = randomUUID();
    await q(`insert into hub_merge_redirect (user_id, kind, from_id, to_id, merged_at) values ($1, 'person', $2, $3, now())`, [
      ctx.userId,
      gone,
      record.id,
    ]);
    const { threadId, version } = await newThread(ctx.userId, src);
    await applyExtraction(
      ctx.userId,
      threadId,
      version,
      extraction({ people: [person({ existingPersonId: gone, companyRef: null })], companies: [], links: [] }),
      context(),
    );
    const f = (await factsOf(ctx.userId)).find((x) => x.type === 'person_email');
    expect(f).toMatchObject({ person_id: record.id, state: 'suggested', reason: 'name_only_match' });
    expect(await q('select id from hub_person where id = $1', [gone])).toHaveLength(0);
  });

  it('stores free text only after inspectSegments: a planted password in evidence is redacted', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    const result = await applyExtraction(
      ctx.userId,
      threadId,
      version,
      extraction({ people: [person({ evidence: `Jan wrote: my password: ${SECRET}` })] }),
      context(),
    );
    expect(result.redactedValues).toBeGreaterThan(0);
    const facts = await factsOf(ctx.userId);
    const withEvidence = facts.filter((f) => f.evidence_enc !== null);
    expect(withEvidence.length).toBeGreaterThan(0);
    for (const f of facts) {
      for (const blob of [f.evidence_enc, f.value_enc, f.previous_value_enc]) {
        if (blob !== null) expect(dec(blob)).not.toContain(SECRET);
      }
    }
  });

  it('a wholly excluded summary stores no summary; the records are still applied', async () => {
    const ctx = await newCtx();
    await addKeywordRule(ctx.userId, 'Zebracorn');
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    const result = await applyExtraction(
      ctx.userId,
      threadId,
      version,
      extraction({ summary: 'Jan asks about the Zebracorn launch.' }),
      context(),
    );
    expect(result).toMatchObject({ outcome: 'done', summaryStored: false });
    const t = await threadOf(threadId);
    expect(t.summary_enc).toBeNull();
    expect(t.summary_version).toBe(0);
    expect(await personsOf(ctx.userId)).toHaveLength(1);
  });

  it('contact outputs pass validateContactValue: an invalid phone is never stored', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    await applyExtraction(
      ctx.userId,
      threadId,
      version,
      extraction({ people: [person({ phone: '4111 1111 1111 1111', phoneBasis: 'signature' })] }),
      context(),
    );
    const [p] = await personsOf(ctx.userId);
    expect(p!.phone_enc).toBeNull();
    for (const f of await factsOf(ctx.userId)) {
      if (f.value_enc !== null) expect(dec(f.value_enc)).not.toContain('4111');
    }
  });

  it('writes nothing when the lease is no longer held', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    await q(`update hub_thread set locked_until = now() - interval '1 second' where id = $1`, [threadId]);
    const result = await applyExtraction(ctx.userId, threadId, version, extraction(), context());
    expect(result.outcome).toBe('lease_lost');
    expect(await personsOf(ctx.userId)).toHaveLength(0);
    expect(await factsOf(ctx.userId)).toHaveLength(0);
    expect(await threadOf(threadId)).toMatchObject({ status: 'pending', processed_version: 0 });
  });

  it('leaves the thread pending when a message bumped the version during the run', async () => {
    const ctx = await newCtx();
    const src = await newSource(ctx.userId);
    const { threadId, version } = await newThread(ctx.userId, src);
    await q('update hub_thread set version = version + 1 where id = $1', [threadId]);
    const result = await applyExtraction(ctx.userId, threadId, version, extraction(), context());
    expect(result.outcome).toBe('done');
    const [t] = await q<{ status: string; processed_version: number; next_attempt_at: Date | null }>(
      'select status, processed_version::int as processed_version, next_attempt_at from hub_thread where id = $1',
      [threadId],
    );
    expect(t).toMatchObject({ status: 'pending', processed_version: 1 });
    expect(t!.next_attempt_at).not.toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { claimThread } from '@voicespark/db/repos/system/hub';
import { decrypt, encrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import type { HubExtraction } from '@voicespark/core/hub/extraction-schema';
import { factFingerprint } from '@voicespark/core/hub/fingerprint';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import { applyExtraction, type ApplyParticipant } from '@voicespark/core/services/hub/apply';
import * as links from '@voicespark/core/services/hub/links';
import * as merge from '@voicespark/core/services/hub/merge';
import * as notes from '@voicespark/core/services/hub/notes';
import * as records from '@voicespark/core/services/hub/records';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US4 merge (T134; data-model.md "hub_merge_redirect", "Provenance and owner_fields" merge rules, "hub_fact";
// contracts/http-api.md "merge-preview", "merge"; contracts/memory-store-hub.md "Merge"; contracts/hub-search.md;
// FR-005, FR-025, FR-032, AS4.3, AS4.4).
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

const H = (c: string) => c.repeat(64);
const enc = (s: string) => encrypt('user-content', s);
const dec = (blob: string) => decrypt('user-content', blob);

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function newCtx(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

async function expectCode(p: Promise<unknown>, code: string, status: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect((err as AppError).status).toBe(status);
}

const doc = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

async function insertFile(userId: string, personId: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_file (user_id, person_id, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id)
     values ($1, $2, $3, 'text/plain', 'txt', 1, $4, gen_random_uuid(), 'k1') returning id`,
    [userId, personId, enc('cv.txt'), H('d')],
  );
  await q(
    `insert into hub_search_doc (user_id, item_type, item_id, owner_kind, owner_id, tokens, updated_at)
     values ($1, 'file', $2, 'person', $3, '{}', now())`,
    [userId, r!.id, personId],
  );
  return r!.id;
}

async function insertThread(userId: string, summary: string | null): Promise<string> {
  const [t] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, status, version, processed_version, summary_enc, message_count)
     values ($1, $2, 'done', 1, 1, $3, 1) returning id`,
    [userId, randomUUID().replace(/-/g, '').padEnd(64, '0'), summary === null ? null : enc(summary)],
  );
  return t!.id;
}

async function attach(userId: string, threadId: string, col: string, id: string): Promise<void> {
  await q(`insert into hub_thread_record (user_id, thread_id, ${col}) values ($1, $2, $3)`, [userId, threadId, id]);
}

interface FactSeed {
  threadId: string;
  type: string;
  field?: string | null;
  value: Record<string, unknown>;
  personId?: string | null;
  companyId?: string | null;
  linkId?: string | null;
  fingerprint?: string;
  state?: string;
}

async function insertFact(userId: string, f: FactSeed): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_fact (user_id, thread_id, type, state, person_id, company_id, link_id, field, value_enc,
                           confidence, fingerprint, policy_version, prompt_version, reason)
     values ($1, $2, $3, $4::hub_fact_state, $5, $6, $7, $8, $9, 0.9, $10, 'hub-policy-v1', 'hub-extract-v1',
             case when $4::text = 'suggested' then 'conflict' end) returning id`,
    [
      userId,
      f.threadId,
      f.type,
      f.state ?? 'applied',
      f.personId ?? null,
      f.companyId ?? null,
      f.linkId ?? null,
      f.field ?? null,
      enc(JSON.stringify(f.value)),
      f.fingerprint ?? randomUUID().replace(/-/g, '').padEnd(64, '0'),
    ],
  );
  return r!.id;
}

const syncRow = async (userId: string, docId: string) =>
  (
    await q<{ version: number; deleted: boolean }>(
      'select version::int as version, deleted from hub_sync_item where user_id = $1 and doc_id = $2',
      [userId, docId],
    )
  )[0];

const markerCount = async (userId: string) =>
  (await q<{ n: number }>('select count(*)::int as n from hub_block_marker where user_id = $1', [userId]))[0]!.n;

/** Kept person A and a duplicate B with emails, a note, a file, links (one duplicate pair), threads and facts. */
async function personWorld() {
  const ctx = await newCtx();
  const u = ctx.userId;
  const a = (
    await records.create(ctx, 'person', { name: 'Jan Kowalski', roleTitle: 'CTO', emails: ['jan@acme.example'] })
  ).record;
  const b = (
    await records.create(ctx, 'person', {
      name: 'Jan K.',
      roleTitle: 'CEO',
      phone: '+48 600 100 200',
      emails: ['jan.k@private.example'],
    })
  ).record;
  // B's description is email-set (not owner-set) so the union of owner_fields is visible.
  await q('update hub_person set description_enc = $2 where id = $1', [b.id, enc('Met at the fair')]);
  const c1 = (await records.create(ctx, 'company', { name: 'Acme' })).record;
  const c2 = (await records.create(ctx, 'company', { name: 'Beta' })).record;
  const keptPair = (await links.create(ctx, { kind: 'person_company', personId: a.id, companyId: c1.id })).link;
  const dupPair = (
    await links.create(ctx, { kind: 'person_company', personId: b.id, companyId: c1.id, role: 'Advisor' })
  ).link;
  const moved = (await links.create(ctx, { kind: 'person_company', personId: b.id, companyId: c2.id })).link;
  const note = await notes.create(ctx, 'person', b.id, { title: 'Call notes', body: doc('Budget talk') } as never);
  const fileId = await insertFile(u, b.id);
  const t1 = await insertThread(u, 'Jan asks for an offer.');
  const t2 = await insertThread(u, 'Both Jans in one thread.');
  await attach(u, t1, 'person_id', b.id);
  await attach(u, t2, 'person_id', a.id);
  await attach(u, t2, 'person_id', b.id);
  const roleValue = { field: 'roleTitle', value: 'CEO' };
  const roleFp = factFingerprint(u, 'field', `person:${a.id}`, JSON.stringify(roleValue));
  // t2 already holds the same finding on A: B's copy in t2 dedupes onto it.
  const keptFact = await insertFact(u, {
    threadId: t2,
    type: 'field',
    field: 'roleTitle',
    value: roleValue,
    personId: a.id,
    fingerprint: roleFp,
    state: 'suggested',
  });
  const factT1 = await insertFact(u, { threadId: t1, type: 'field', field: 'roleTitle', value: roleValue, personId: b.id });
  const factT2 = await insertFact(u, { threadId: t2, type: 'field', field: 'roleTitle', value: roleValue, personId: b.id });
  const linkFact = await insertFact(u, {
    threadId: t1,
    type: 'link_role',
    field: 'role',
    value: { role: 'Advisor' },
    personId: b.id,
    companyId: c1.id,
    linkId: dupPair.id,
  });
  return { ctx, u, a, b, c1, c2, keptPair, dupPair, moved, note, fileId, t1, t2, keptFact, factT1, factT2, linkFact, roleFp };
}

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('merge preview', () => {
  it('counts what moves and names the kept and filled fields', async () => {
    const w = await personWorld();
    const p = await merge.preview(w.ctx, 'person', w.a.id, w.b.id);
    expect(p).toEqual({
      moves: { emails: 1, domains: 0, notes: 1, files: 1, links: 1, linkDuplicates: 1, summaries: 2, facts: 3 },
      keptValues: ['name', 'roleTitle'],
      filledValues: ['phone', 'description'],
    });
    // A preview writes nothing.
    expect(await q('select id from hub_person where id = $1', [w.b.id])).toHaveLength(1);
  });
});

describe('merge', () => {
  it('keeps the kept values, fills nulls, unions owner_fields and moves everything (AS4.3)', async () => {
    const w = await personWorld();
    const markers = await markerCount(w.u);
    const { record } = await merge.merge(w.ctx, 'person', w.a.id, w.b.id);
    expect(record).toMatchObject({
      id: w.a.id,
      name: 'Jan Kowalski',
      roleTitle: 'CTO',
      phone: '+48 600 100 200',
      description: 'Met at the fair',
    });
    expect([...(record as records.PersonView).ownerFields].sort()).toEqual(['name', 'phone', 'roleTitle']);
    const emails = (record as records.PersonView).emails;
    expect(emails.map((e) => e.address).sort()).toEqual(['jan.k@private.example', 'jan@acme.example']);
    expect(emails.filter((e) => e.isPrimary).map((e) => e.address)).toEqual(['jan@acme.example']);

    // The source row is gone; notes and files belong to the kept record.
    expect(await q('select id from hub_person where id = $1', [w.b.id])).toHaveLength(0);
    expect((await q<{ person_id: string }>('select person_id from hub_note where id = $1', [w.note.id]))[0]!.person_id).toBe(w.a.id);
    expect((await q<{ person_id: string }>('select person_id from hub_file where id = $1', [w.fileId]))[0]!.person_id).toBe(w.a.id);

    // Links: the non-duplicate moves; the duplicate pair keeps the kept row and fills its role.
    const ls = await q<{ id: string; company_id: string; role_enc: string | null }>(
      'select id, company_id, role_enc from hub_link where user_id = $1 and person_id = $2 order by created_at',
      [w.u, w.a.id],
    );
    expect(ls.map((l) => l.id).sort()).toEqual([w.keptPair.id, w.moved.id].sort());
    expect(dec(ls.find((l) => l.id === w.keptPair.id)!.role_enc!)).toBe('Advisor');
    expect(await q('select id from hub_link where id = $1', [w.dupPair.id])).toHaveLength(0);

    // Thread records move, deduped per thread.
    const tr = await q<{ thread_id: string; person_id: string }>(
      'select thread_id, person_id from hub_thread_record where user_id = $1 order by thread_id',
      [w.u],
    );
    expect(tr).toHaveLength(2);
    expect(tr.every((r) => r.person_id === w.a.id)).toBe(true);

    // Facts: re-fingerprinted on the kept id and deduped on (thread_id, fingerprint).
    const facts = await q<{ id: string; thread_id: string; person_id: string; link_id: string | null; fingerprint: string }>(
      'select id, thread_id, person_id, link_id, fingerprint from hub_fact where user_id = $1',
      [w.u],
    );
    expect(facts.map((f) => f.id).sort()).toEqual([w.keptFact, w.factT1, w.linkFact].sort());
    expect(facts.every((f) => f.person_id === w.a.id)).toBe(true);
    expect(facts.find((f) => f.id === w.factT1)!.fingerprint).toBe(w.roleFp);
    const lf = facts.find((f) => f.id === w.linkFact)!;
    expect(lf.link_id).toBe(w.keptPair.id);
    expect(lf.fingerprint).toBe(
      factFingerprint(
        w.u,
        'link_role',
        `person_company:person:${w.a.id}:company:${w.c1.id}`,
        JSON.stringify({ field: null, role: 'Advisor' }),
      ),
    );

    // Redirect, no block markers, audit.
    expect(
      await q('select to_id from hub_merge_redirect where user_id = $1 and kind = $2 and from_id = $3', [w.u, 'person', w.b.id]),
    ).toEqual([{ to_id: w.a.id }]);
    expect(await markerCount(w.u)).toBe(markers);
    const audits = await q<{ target_id: string; metadata: unknown }>(
      `select target_id, metadata from audit_log_entry where actor_user_id = $1 and action = 'hub.records_merged'`,
      [w.u],
    );
    expect(audits).toEqual([{ target_id: w.a.id, metadata: { kind: 'person' } }]);
  });

  it('tombstones the merged-away document, marks the kept tree and rewrites the search rows in the transaction', async () => {
    const w = await personWorld();
    const keptBefore = (await syncRow(w.u, `hub_person_${w.a.id}`))!.version;
    const noteBefore = (await syncRow(w.u, `hub_note_${w.note.id}`))!.version;
    await merge.merge(w.ctx, 'person', w.a.id, w.b.id);

    expect(await syncRow(w.u, `hub_person_${w.b.id}`)).toMatchObject({ deleted: true });
    expect((await syncRow(w.u, `hub_person_${w.a.id}`))!.version).toBeGreaterThan(keptBefore);
    expect((await syncRow(w.u, `hub_note_${w.note.id}`))!).toMatchObject({ deleted: false });
    expect((await syncRow(w.u, `hub_note_${w.note.id}`))!.version).toBeGreaterThan(noteBefore);
    expect(await syncRow(w.u, `hub_company_${w.c2.id}`)).toBeDefined();
    expect(await syncRow(w.u, `hub_summary_${w.t1}`)).toMatchObject({ deleted: false });

    expect(
      await q('select id from hub_search_doc where user_id = $1 and item_type = $2 and item_id = $3', [w.u, 'person', w.b.id]),
    ).toHaveLength(0);
    const owned = await q<{ item_type: string; owner_id: string }>(
      `select item_type, owner_id from hub_search_doc where user_id = $1 and item_type in ('note', 'file') order by item_type`,
      [w.u],
    );
    expect(owned).toEqual([
      { item_type: 'file', owner_id: w.a.id },
      { item_type: 'note', owner_id: w.a.id },
    ]);
    const [kept] = await q<{ tokens: string[] }>(
      'select tokens from hub_search_doc where user_id = $1 and item_type = $2 and item_id = $3',
      [w.u, 'person', w.a.id],
    );
    expect(kept!.tokens.map((t) => t.trim())).toEqual(
      expect.arrayContaining(indexTokens(w.u, ['jan.k@private.example']).map((t) => t.trim())),
    );
  });

  it('moves company domains and project dates', async () => {
    const ctx = await newCtx();
    const a = (await records.create(ctx, 'company', { name: 'Acme', domains: ['acme.example'] })).record;
    const b = (
      await records.create(ctx, 'company', { name: 'ACME sp. z o.o.', industry: 'Software', domains: ['acme.pl'] })
    ).record;
    expect((await merge.preview(ctx, 'company', a.id, b.id)).moves.domains).toBe(1);
    const { record } = await merge.merge(ctx, 'company', a.id, b.id);
    expect(record).toMatchObject({ name: 'Acme', industry: 'Software' });
    expect((record as records.CompanyView).domains.map((d) => d.domain).sort()).toEqual(['acme.example', 'acme.pl']);

    const p1 = (await records.create(ctx, 'project', { name: 'Kickoff', status: 'active' })).record;
    const p2 = (
      await records.create(ctx, 'project', { name: 'Kickoff 2', status: 'planned', startDate: '2026-01-01', endDate: '2026-02-01' })
    ).record;
    const merged = (await merge.merge(ctx, 'project', p1.id, p2.id)).record;
    expect(merged).toMatchObject({ status: 'active', startDate: '2026-01-01', endDate: '2026-02-01' });
  });

  it('rejects the same id, a different kind and unknown or foreign ids', async () => {
    const ctx = await newCtx();
    const other = await newCtx();
    const a = (await records.create(ctx, 'person', { name: 'Anna' })).record;
    const company = (await records.create(ctx, 'company', { name: 'Anna Corp' })).record;
    const foreign = (await records.create(other, 'person', { name: 'Anna' })).record;
    for (const run of [merge.preview, merge.merge]) {
      await expectCode(run(ctx, 'person', a.id, a.id), 'merge_invalid', 409);
      await expectCode(run(ctx, 'person', a.id, company.id), 'merge_invalid', 409);
      await expectCode(run(ctx, 'person', a.id, foreign.id), 'not_found', 404);
      await expectCode(run(ctx, 'person', foreign.id, a.id), 'not_found', 404);
      await expectCode(run(ctx, 'person', a.id, randomUUID()), 'not_found', 404);
      await expectCode(run(ctx, 'person', a.id, 'not-a-uuid'), 'not_found', 404);
      // A foreign self-merge does not reveal that the id exists.
      await expectCode(run(ctx, 'person', foreign.id, foreign.id), 'not_found', 404);
    }
    expect(await q('select id from hub_person where id = $1', [foreign.id])).toHaveLength(1);
    expect(await q('select from_id from hub_merge_redirect where user_id = $1', [ctx.userId])).toHaveLength(0);
  });

  it('re-points chained redirects and drops redirects to a deleted record (FR-005)', async () => {
    const ctx = await newCtx();
    const x = (await records.create(ctx, 'person', { name: 'X' })).record;
    const y = (await records.create(ctx, 'person', { name: 'Y' })).record;
    const z = (await records.create(ctx, 'person', { name: 'Z' })).record;
    await merge.merge(ctx, 'person', y.id, x.id);
    await merge.merge(ctx, 'person', z.id, y.id);
    expect(
      await q<{ from_id: string; to_id: string }>(
        'select from_id, to_id from hub_merge_redirect where user_id = $1 order by from_id',
        [ctx.userId],
      ),
    ).toEqual(
      [
        { from_id: x.id, to_id: z.id },
        { from_id: y.id, to_id: z.id },
      ].sort((p, r) => (p.from_id < r.from_id ? -1 : 1)),
    );
    await records.remove(ctx, 'person', z.id);
    expect(await q('select from_id from hub_merge_redirect where user_id = $1', [ctx.userId])).toHaveLength(0);
  });

  it('waits for the per-user apply lock', async () => {
    const ctx = await newCtx();
    const a = (await records.create(ctx, 'person', { name: 'A' })).record;
    const b = (await records.create(ctx, 'person', { name: 'B' })).record;
    const holder = await getPool().connect();
    try {
      await holder.query('begin');
      await holder.query(`select pg_advisory_xact_lock(hashtext('hub-apply:' || $1))`, [ctx.userId]);
      let done = false;
      const run = merge.merge(ctx, 'person', a.id, b.id).then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      expect(await q('select id from hub_person where id = $1', [b.id])).toHaveLength(1);
      await holder.query('commit');
      await run;
      expect(await q('select id from hub_person where id = $1', [b.id])).toHaveLength(0);
    } finally {
      holder.release();
    }
  });

  it('a later extraction naming the merged-away id updates the kept record (AS4.4)', async () => {
    const ctx = await newCtx();
    const u = ctx.userId;
    const kept = (await records.create(ctx, 'person', { name: 'Jan Kowalski' })).record;
    const gone = (await records.create(ctx, 'person', { name: 'Jan Kowalski' })).record;
    await merge.merge(ctx, 'person', kept.id, gone.id);

    const [src] = await q<{ id: string }>(
      `insert into connected_source (user_id, type, account_label, account_address, status, consent_text_version)
       values ($1, 'imap', 'me@owner.example', 'me@owner.example', 'connected', 'v1') returning id`,
      [u],
    );
    await q(`insert into hub_mailbox_setting (source_id, user_id, enabled) values ($1, $2, true)`, [src!.id, u]);
    const [t] = await q<{ id: string }>(
      `insert into hub_thread (user_id, thread_key, status, version, processed_version, next_attempt_at,
                               first_message_at, last_message_at, message_count)
       values ($1, $2, 'pending', 1, 0, now() - interval '1 second', now(), now(), 2) returning id`,
      [u, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    );
    await q('insert into hub_thread_source (user_id, thread_id, source_id) values ($1, $2, $3)', [u, t!.id, src!.id]);
    const version = (await claimThread(t!.id))!;
    const participant = (key: string, address: string, owner: boolean): ApplyParticipant => ({
      key,
      address,
      name: owner ? 'Me' : 'Jan Kowalski',
      roles: [owner ? 'to' : 'from'],
      sent: !owner,
      owner,
      automated: false,
      roleAddress: false,
      freeMail: false,
      messagesSent: owner ? 0 : 1,
      directToOnOwnerSent: false,
    });
    const extraction: HubExtraction = {
      relevant: true,
      language: 'pl',
      summary: 'Jan writes again.',
      people: [
        {
          participantKey: 'P1',
          existingPersonId: gone.id,
          name: 'Jan Kowalski',
          isHuman: true,
          roleTitle: null,
          roleTitleBasis: null,
          phone: null,
          phoneBasis: null,
          companyRef: null,
          confidence: 0.95,
          evidence: 'Signature: Jan Kowalski',
        },
      ],
      companies: [],
      projects: [],
      links: [],
    };
    await applyExtraction(u, t!.id, version, extraction, {
      participants: [participant('P1', 'jan@acme.example', false), participant('P2', 'me@owner.example', true)],
      ownerAddresses: ['me@owner.example'],
      promptVersion: 'hub-extract-v1',
    });
    const facts = await q<{ person_id: string | null }>('select person_id from hub_fact where user_id = $1', [u]);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.person_id === kept.id)).toBe(true);
    expect(await q('select id from hub_person where user_id = $1', [u])).toHaveLength(1);
  });
});

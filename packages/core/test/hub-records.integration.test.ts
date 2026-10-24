import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt, encrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import { markerKey } from '@voicespark/core/hub/fingerprint';
import { addressHash, matchHash, matchKey, nameKey } from '@voicespark/core/hub/normalize';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import * as records from '@voicespark/core/services/hub/records';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US1 records (T045; data-model.md "hub_person" .. "hub_project", "Provenance and owner_fields", "Validation rules",
// "Deletion behaviour"; contracts/http-api.md "Records"; contracts/hub-search.md; FR-001..FR-004, FR-006, FR-016).
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
process.env.HUB_FILES_DIR ??= mkdtempSync(join(tmpdir(), 'hub-records-'));
process.env.NODE_ENV ??= 'test';

const H = (c: string) => c.repeat(64);
const CARD = '4111 1111 1111 1111';

async function expectCode(p: Promise<unknown>, code: string, status?: number): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status !== undefined) expect((err as AppError).status).toBe(status);
  return err as AppError;
}

async function setup(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function personRow(id: string) {
  const [r] = await q<{
    name_enc: string;
    name_key: string;
    match_key: string;
    role_title_enc: string | null;
    phone_enc: string | null;
    description_enc: string | null;
    owner_fields: string[];
    created_from: string;
  }>('select * from hub_person where id = $1', [id]);
  return r;
}

async function emailRows(personId: string) {
  return q<{ id: string; address_enc: string; address_hash: string; match_hash: string; is_primary: boolean; origin: string }>(
    'select * from hub_person_email where person_id = $1 order by created_at, id',
    [personId],
  );
}

async function syncRow(userId: string, type: string, id: string) {
  const [r] = await q<{ version: number; deleted: boolean; status: string }>(
    `select version::int as version, deleted, status from hub_sync_item where user_id = $1 and doc_id = $2`,
    [userId, `hub_${type}_${id}`],
  );
  return r;
}

async function searchTokens(userId: string, type: string, id: string): Promise<string[] | null> {
  const [r] = await q<{ tokens: string[] }>(
    'select tokens from hub_search_doc where user_id = $1 and item_type = $2 and item_id = $3',
    [userId, type, id],
  );
  return r ? r.tokens.map((t) => t.trim()) : null;
}

function expectIndexed(tokens: string[] | null, userId: string, words: string[]): void {
  expect(tokens).not.toBeNull();
  expect(tokens).toEqual(expect.arrayContaining(indexTokens(userId, words)));
}

async function markers(userId: string): Promise<string[]> {
  const rows = await q<{ key_hash: string }>('select key_hash from hub_block_marker where user_id = $1', [userId]);
  return rows.map((r) => r.key_hash);
}

async function auditRows(userId: string, action: string) {
  return q<{ actor_type: string; target_type: string; target_id: string; metadata: Record<string, unknown> }>(
    `select actor_type, target_type, target_id, metadata from audit_log_entry
      where actor_user_id = $1 and action = $2 order by occurred_at, id`,
    [userId, action],
  );
}

async function seedNote(userId: string, col: string, ownerId: string, ownerKind: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_note (user_id, ${col}, title_enc, body_json_enc) values ($1, $2, 'x', 'x') returning id`,
    [userId, ownerId],
  );
  await q(
    `insert into hub_search_doc (user_id, item_type, item_id, owner_kind, owner_id, tokens, updated_at)
     values ($1, 'note', $2, $3, $4, '{}', now())`,
    [userId, r!.id, ownerKind, ownerId],
  );
  return r!.id;
}

async function seedFile(userId: string, col: string, ownerId: string, ownerKind: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_file (user_id, ${col}, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id)
     values ($1, $2, 'x', 'text/plain', 'txt', 1, $3, gen_random_uuid(), 'k1') returning id`,
    [userId, ownerId, H('d')],
  );
  await q(
    `insert into hub_search_doc (user_id, item_type, item_id, owner_kind, owner_id, tokens, updated_at)
     values ($1, 'file', $2, $3, $4, '{}', now())`,
    [userId, r!.id, ownerKind, ownerId],
  );
  return r!.id;
}

async function seedLink(
  userId: string,
  kind: 'person_company' | 'person_project' | 'company_project',
  ends: { personId?: string; companyId?: string; projectId?: string },
): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_link (user_id, kind, person_id, company_id, project_id, origin)
     values ($1, $2, $3, $4, $5, 'user') returning id`,
    [userId, kind, ends.personId ?? null, ends.companyId ?? null, ends.projectId ?? null],
  );
  return r!.id;
}

async function seedThreadRecord(userId: string, personId: string): Promise<string> {
  const [t] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key) values ($1, $2) returning id`,
    [userId, H('e')],
  );
  await q(`insert into hub_thread_record (user_id, thread_id, person_id) values ($1, $2, $3)`, [
    userId,
    t!.id,
    personId,
  ]);
  return t!.id;
}

async function seedAppliedFact(userId: string, personId: string, field: string, fp: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_fact (user_id, type, state, person_id, field, value_enc, confidence, fingerprint,
                           policy_version, prompt_version)
     values ($1, 'field', 'applied', $2, $3, $4, 0.9, $5, 'hub-policy-v1', 'test') returning id`,
    [userId, personId, field, encrypt('user-content', JSON.stringify({ kind: 'text', value: 'x' })), fp],
  );
  return r!.id;
}

async function factState(id: string): Promise<string> {
  const [r] = await q<{ state: string }>('select state from hub_fact where id = $1', [id]);
  return r!.state;
}

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('create', () => {
  it('creates a person with two emails: lower-cased, hashed, encrypted, first primary', async () => {
    const ctx = await setup();
    const res = await records.create(ctx, 'person', {
      name: 'Anna Nowak',
      roleTitle: 'CTO',
      phone: '+48 600 700 800',
      emails: ['Anna@Acme.TEST', 'anna+work@acme.test'],
    });
    const p = res.record as records.PersonView;
    expect(p).toMatchObject({
      name: 'Anna Nowak',
      roleTitle: 'CTO',
      phone: '+48 600 700 800',
      description: null,
      createdFrom: 'user',
    });
    expect(typeof p.id).toBe('string');
    expect(typeof p.createdAt).toBe('string');
    expect(typeof p.updatedAt).toBe('string');
    expect(p.emails.map((e) => [e.address, e.isPrimary, e.origin])).toEqual([
      ['anna@acme.test', true, 'user'],
      ['anna+work@acme.test', false, 'user'],
    ]);
    expect(res.similar).toEqual([]);
    expect(res.redactedValues ?? 0).toBe(0);

    const row = await personRow(p.id);
    expect(row!.name_enc).not.toContain('Anna');
    expect(decrypt('user-content', row!.name_enc)).toBe('Anna Nowak');
    expect(decrypt('user-content', row!.role_title_enc!)).toBe('CTO');
    expect(decrypt('user-content', row!.phone_enc!)).toBe('+48 600 700 800');
    expect(row!.name_key).toBe(nameKey(ctx.userId, 'person', 'Anna Nowak'));
    expect(row!.match_key).toBe(matchKey(ctx.userId, 'person', 'Anna Nowak'));
    expect(row!.created_from).toBe('user');

    const emails = await emailRows(p.id);
    expect(emails).toHaveLength(2);
    expect(emails.map((e) => decrypt('user-content', e.address_enc))).toEqual([
      'anna@acme.test',
      'anna+work@acme.test',
    ]);
    expect(emails[0]!.address_hash).toBe(addressHash('anna@acme.test'));
    expect(emails[0]!.match_hash).toBe(matchHash('anna@acme.test'));
    expect(emails[1]!.address_hash).toBe(addressHash('anna+work@acme.test'));
    expect(emails[1]!.match_hash).toBe(matchHash('anna@acme.test'));
    expect(emails.map((e) => e.is_primary)).toEqual([true, false]);
  });

  it('accepts +48 mobiles whose digits pass the Steuer-ID checksum (not a government id)', async () => {
    const ctx = await setup();
    for (const phone of ['+48 601 300 707', '+48 601-300-707', '+48601300707']) {
      const res = await records.create(ctx, 'person', { name: `P ${phone}`, phone });
      expect((res.record as records.PersonView).phone).toBe(phone);
    }
  });

  it('creates a company with domains and a bare-domain website normalised to https', async () => {
    const ctx = await setup();
    const res = await records.create(ctx, 'company', {
      name: 'Acme sp. z o.o.',
      website: 'acme.test',
      industry: 'Software',
      domains: ['Acme.test'],
    });
    const c = res.record as records.CompanyView;
    expect(c.website).toMatch(/^https:\/\/acme\.test\/?$/);
    expect(c.industry).toBe('Software');
    expect(c.domains.map((d) => [d.domain, d.origin])).toEqual([['acme.test', 'user']]);
    const [row] = await q<{ domain_enc: string; domain_hash: string }>(
      'select domain_enc, domain_hash from hub_company_domain where company_id = $1',
      [c.id],
    );
    expect(decrypt('user-content', row!.domain_enc)).toBe('acme.test');
    expect(row!.domain_hash).toHaveLength(64);
    const [rec] = await q<{ match_key: string }>('select match_key from hub_company where id = $1', [c.id]);
    expect(rec!.match_key).toBe(matchKey(ctx.userId, 'company', 'Acme sp. z o.o.'));
  });

  it('creates a project with default status planned and dates', async () => {
    const ctx = await setup();
    const res = await records.create(ctx, 'project', {
      name: 'Website relaunch',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    });
    const p = res.record as records.ProjectView;
    expect(p).toMatchObject({ name: 'Website relaunch', status: 'planned', startDate: '2026-01-01', endDate: '2026-03-31' });
  });
});

describe('validation', () => {
  const long = (n: number) => 'a'.repeat(n);

  it.each([
    ['empty name', 'person', { name: '' }],
    ['blank name', 'person', { name: '   ' }],
    ['name over 200', 'person', { name: long(201) }],
    ['role over 200', 'person', { name: 'A', roleTitle: long(201) }],
    ['phone over 50', 'person', { name: 'A', phone: '1'.repeat(51) }],
    ['phone with letters', 'person', { name: 'A', phone: 'call me' }],
    ['email over 320', 'person', { name: 'A', emails: [`${long(64)}@${long(252)}.test`] }],
    ['invalid email', 'person', { name: 'A', emails: ['not-an-email'] }],
    ['description over 2000', 'person', { name: 'A', description: long(2001) }],
    ['invalid domain', 'company', { name: 'A', domains: ['bad_domain'] }],
    ['www. domain', 'company', { name: 'A', domains: ['www.acme.test'] }],
    ['non-http website', 'company', { name: 'A', website: 'ftp://acme.test' }],
    ['website not a url', 'company', { name: 'A', website: 'not a website' }],
    ['industry over 200', 'company', { name: 'A', industry: long(201) }],
    ['status outside the enum', 'project', { name: 'A', status: 'done' }],
    ['end before start', 'project', { name: 'A', startDate: '2026-02-01', endDate: '2026-01-31' }],
    ['invalid date', 'project', { name: 'A', startDate: '2026-13-01' }],
  ] as const)('%s -> 422 validation_failed and nothing stored', async (_label, kind, input) => {
    const ctx = await setup();
    await expectCode(records.create(ctx, kind, input as never), 'validation_failed', 422);
    const table = kind === 'person' ? 'hub_person' : kind === 'company' ? 'hub_company' : 'hub_project';
    expect(await q(`select id from ${table} where user_id = $1`, [ctx.userId])).toHaveLength(0);
  });

  it('end before start on patch -> 422', async () => {
    const ctx = await setup();
    const { record } = await records.create(ctx, 'project', { name: 'P', startDate: '2026-02-01' });
    await expectCode(records.patch(ctx, 'project', record.id, { endDate: '2026-01-01' }), 'validation_failed', 422);
  });

  it('duplicate email or domain across the user records -> 409 conflict; other users unaffected', async () => {
    const ctx = await setup();
    const a = await records.create(ctx, 'person', { name: 'A', emails: ['a@acme.test'] });
    await expectCode(records.create(ctx, 'person', { name: 'B', emails: ['A@ACME.test'] }), 'conflict', 409);
    const b = await records.create(ctx, 'person', { name: 'B' });
    await expectCode(records.addEmail(ctx, 'person', b.record.id, { address: 'a@acme.test' }), 'conflict', 409);
    await expectCode(records.addEmail(ctx, 'person', a.record.id, { address: 'a@acme.test' }), 'conflict', 409);

    await records.create(ctx, 'company', { name: 'C', domains: ['acme.test'] });
    await expectCode(records.create(ctx, 'company', { name: 'D', domains: ['ACME.test'] }), 'conflict', 409);
    const d = await records.create(ctx, 'company', { name: 'D' });
    await expectCode(records.addDomain(ctx, 'company', d.record.id, { domain: 'acme.test' }), 'conflict', 409);

    const other = await setup();
    await records.create(other, 'person', { name: 'A', emails: ['a@acme.test'] });
    await records.create(other, 'company', { name: 'C', domains: ['acme.test'] });
  });

  it('a contact value with a secret -> 422 sensitive_content with details.fields, nothing stored', async () => {
    const ctx = await setup();
    const err = await expectCode(records.create(ctx, 'person', { name: 'A', phone: CARD }), 'sensitive_content', 422);
    expect(err.details?.fields).toEqual(expect.arrayContaining(['phone']));
    expect(JSON.stringify(err.details)).not.toContain('4111');
    expect(await q('select id from hub_person where user_id = $1', [ctx.userId])).toHaveLength(0);

    const { record } = await records.create(ctx, 'person', { name: 'A' });
    const perr = await expectCode(records.patch(ctx, 'person', record.id, { phone: CARD }), 'sensitive_content', 422);
    expect(perr.details?.fields).toEqual(expect.arrayContaining(['phone']));
    expect((await personRow(record.id))!.phone_enc).toBeNull();
  });

  it('free text passes inspectSegments: stored redacted and redactedValues returned', async () => {
    const ctx = await setup();
    const res = await records.create(ctx, 'person', {
      name: 'Card Holder',
      description: `Pays with card ${CARD} every month`,
    });
    expect(res.redactedValues).toBe(1);
    const p = res.record as records.PersonView;
    expect(p.description).not.toContain('4111');
    expect(p.description).toMatch(/\[excluded: /);
    const row = await personRow(p.id);
    expect(decrypt('user-content', row!.description_enc!)).not.toContain('4111');

    const patched = await records.patch(ctx, 'person', p.id, { roleTitle: `Card ${CARD}` });
    expect(patched.redactedValues).toBe(1);
    expect((patched.record as records.PersonView).roleTitle).not.toContain('4111');
  });
});

describe('similar (FR-003)', () => {
  it('lists same-kind records with the same name ignoring case on create and rename, never blocks', async () => {
    const ctx = await setup();
    const first = await records.create(ctx, 'person', { name: 'Anna Nowak' });
    await records.create(ctx, 'company', { name: 'Anna Nowak' });

    const second = await records.create(ctx, 'person', { name: 'anna nowak' });
    expect(second.record.id).not.toBe(first.record.id);
    expect(second.similar).toEqual([{ id: first.record.id, name: 'Anna Nowak' }]);

    const third = await records.create(ctx, 'person', { name: 'Jan Kowalski' });
    expect(third.similar).toEqual([]);
    const renamed = await records.patch(ctx, 'person', third.record.id, { name: '  ANNA NOWAK ' });
    expect(renamed.similar.map((s) => s.id).sort()).toEqual([first.record.id, second.record.id].sort());
    expect(renamed.similar.map((s) => s.id)).not.toContain(third.record.id);

    // Another user's same-named record is never similar.
    const other = await setup();
    expect((await records.create(other, 'person', { name: 'Anna Nowak' })).similar).toEqual([]);
  });
});

describe('owner_fields (FR-016)', () => {
  it('create stores every non-null submitted field', async () => {
    const ctx = await setup();
    const { record } = await records.create(ctx, 'person', { name: 'A', roleTitle: 'CEO', description: null });
    expect(record.ownerFields).toEqual(expect.arrayContaining(['name', 'roleTitle']));
    expect(record.ownerFields).not.toContain('description');
    expect(record.ownerFields).not.toContain('phone');
    expect((await personRow(record.id))!.owner_fields).toEqual(expect.arrayContaining(['name', 'roleTitle']));
  });

  it('patch adds every patched field, including null, and overrides applied email facts on those fields', async () => {
    const ctx = await setup();
    const { record } = await records.create(ctx, 'person', { name: 'A' });
    await q(`update hub_person set created_from = 'email', owner_fields = '{}' where id = $1`, [record.id]);
    const roleFact = await seedAppliedFact(ctx.userId, record.id, 'roleTitle', H('1'));
    const phoneFact = await seedAppliedFact(ctx.userId, record.id, 'phone', H('2'));

    const res = await records.patch(ctx, 'person', record.id, { roleTitle: null, description: 'Met at a fair' });
    expect(res.record.ownerFields.sort()).toEqual(['description', 'roleTitle']);
    expect(res.record.createdFrom).toBe('email');
    expect(await factState(roleFact)).toBe('overridden');
    expect(await factState(phoneFact)).toBe('applied');

    const again = await records.patch(ctx, 'person', record.id, { phone: '+48 600 700 800' });
    expect(again.record.ownerFields.sort()).toEqual(['description', 'phone', 'roleTitle']);
    expect(await factState(phoneFact)).toBe('overridden');
  });
});

describe('get', () => {
  it('returns the record, its links with the other end and the sync field', async () => {
    const ctx = await setup();
    const person = await records.create(ctx, 'person', { name: 'Anna' });
    const company = await records.create(ctx, 'company', { name: 'Acme' });
    const linkId = await seedLink(ctx.userId, 'person_company', {
      personId: person.record.id,
      companyId: company.record.id,
    });

    const res = await records.get(ctx, 'person', person.record.id);
    expect(res.record).toMatchObject({ id: person.record.id, name: 'Anna' });
    expect(res.links).toHaveLength(1);
    expect(res.links[0]!.link).toMatchObject({ id: linkId, kind: 'person_company', origin: 'user' });
    expect(res.links[0]!.other).toEqual({ kind: 'company', id: company.record.id, name: 'Acme' });
    expect(res.sync).toEqual({ status: 'pending', lastSyncedAt: null });

    const fromCompany = await records.get(ctx, 'company', company.record.id);
    expect(fromCompany.links[0]!.other).toEqual({ kind: 'person', id: person.record.id, name: 'Anna' });
  });
});

describe('email and domain endpoints', () => {
  it('addEmail / removeEmail and addDomain / removeDomain; markers for email-origin values', async () => {
    const ctx = await setup();
    const { record } = await records.create(ctx, 'person', { name: 'A' });
    const before = (await syncRow(ctx.userId, 'person', record.id))!.version;

    const email = await records.addEmail(ctx, 'person', record.id, { address: 'New@Acme.test' });
    expect(email).toMatchObject({ address: 'new@acme.test', isPrimary: true, origin: 'user' });
    expect((await syncRow(ctx.userId, 'person', record.id))!.version).toBeGreaterThan(before);
    expectIndexed(await searchTokens(ctx.userId, 'person', record.id), ctx.userId, ['new@acme.test']);

    await records.removeEmail(ctx, 'person', record.id, email.id);
    expect(await emailRows(record.id)).toHaveLength(0);
    expect(await markers(ctx.userId)).toEqual([]);

    const fromMail = await records.addEmail(ctx, 'person', record.id, { address: 'mail@acme.test' });
    await q(`update hub_person_email set origin = 'email' where id = $1`, [fromMail.id]);
    await records.removeEmail(ctx, 'person', record.id, fromMail.id);
    expect(await markers(ctx.userId)).toContain(markerKey.personEmail('mail@acme.test'));

    const company = await records.create(ctx, 'company', { name: 'C' });
    const domain = await records.addDomain(ctx, 'company', company.record.id, { domain: 'acme.test' });
    expect(domain).toMatchObject({ domain: 'acme.test', origin: 'user' });
    await expectCode(
      records.addDomain(ctx, 'company', company.record.id, { domain: 'www.other.test' }),
      'validation_failed',
      422,
    );
    await q(`update hub_company_domain set origin = 'email' where id = $1`, [domain.id]);
    await records.removeDomain(ctx, 'company', company.record.id, domain.id);
    expect(await markers(ctx.userId)).toContain(markerKey.companyDomain('acme.test'));
  });

  it('emails only on people and domains only on companies (404 otherwise)', async () => {
    const ctx = await setup();
    const company = await records.create(ctx, 'company', { name: 'C' });
    const person = await records.create(ctx, 'person', { name: 'P' });
    await expectCode(records.addEmail(ctx, 'company', company.record.id, { address: 'a@b.test' }), 'not_found', 404);
    await expectCode(records.addDomain(ctx, 'person', person.record.id, { domain: 'b.test' }), 'not_found', 404);
  });
});

describe('delete (FR-004)', () => {
  it('deletePreview returns {notes, files, links}', async () => {
    const ctx = await setup();
    const person = await records.create(ctx, 'person', { name: 'P' });
    const company = await records.create(ctx, 'company', { name: 'C' });
    const project = await records.create(ctx, 'project', { name: 'X' });
    await seedLink(ctx.userId, 'person_company', { personId: person.record.id, companyId: company.record.id });
    await seedLink(ctx.userId, 'person_project', { personId: person.record.id, projectId: project.record.id });
    await seedNote(ctx.userId, 'person_id', person.record.id, 'person');
    await seedNote(ctx.userId, 'person_id', person.record.id, 'person');
    await seedFile(ctx.userId, 'person_id', person.record.id, 'person');

    expect(await records.deletePreview(ctx, 'person', person.record.id)).toEqual({ notes: 2, files: 1, links: 2 });
    expect(await records.deletePreview(ctx, 'company', company.record.id)).toEqual({ notes: 0, files: 0, links: 1 });
  });

  it('cascades, keeps linked records, writes markers, tombstone, search delete and audit', async () => {
    const ctx = await setup();
    const person = await records.create(ctx, 'person', {
      name: 'P',
      emails: ['user@acme.test', 'mail@acme.test'],
    });
    const pid = person.record.id;
    await q(`update hub_person_email set origin = 'email' where person_id = $1 and is_primary = false`, [pid]);
    const company = await records.create(ctx, 'company', { name: 'Acme' });
    const linkId = await seedLink(ctx.userId, 'person_company', { personId: pid, companyId: company.record.id });
    const noteId = await seedNote(ctx.userId, 'person_id', pid, 'person');
    const fileId = await seedFile(ctx.userId, 'person_id', pid, 'person');
    const threadId = await seedThreadRecord(ctx.userId, pid);

    await records.remove(ctx, 'person', pid);

    expect(await personRow(pid)).toBeUndefined();
    expect(await emailRows(pid)).toHaveLength(0);
    expect(await q('select id from hub_link where id = $1', [linkId])).toHaveLength(0);
    expect(await q('select id from hub_note where id = $1', [noteId])).toHaveLength(0);
    expect(await q('select id from hub_file where id = $1', [fileId])).toHaveLength(0);
    expect(await q('select id from hub_thread_record where thread_id = $1', [threadId])).toHaveLength(0);
    expect(await q('select id from hub_thread where id = $1', [threadId])).toHaveLength(1);
    // The linked company is kept and marked dirty.
    expect((await records.get(ctx, 'company', company.record.id)).links).toEqual([]);
    expect(await syncRow(ctx.userId, 'company', company.record.id)).toMatchObject({ deleted: false, status: 'pending' });

    // Markers only for email-origin values.
    const m = await markers(ctx.userId);
    expect(m).toContain(markerKey.personEmail('mail@acme.test'));
    expect(m).not.toContain(markerKey.personEmail('user@acme.test'));

    // Tombstones and search rows.
    expect(await syncRow(ctx.userId, 'person', pid)).toMatchObject({ deleted: true });
    expect(await syncRow(ctx.userId, 'note', noteId)).toMatchObject({ deleted: true });
    expect(await syncRow(ctx.userId, 'file', fileId)).toMatchObject({ deleted: true });
    expect(await searchTokens(ctx.userId, 'person', pid)).toBeNull();
    expect(await searchTokens(ctx.userId, 'note', noteId)).toBeNull();
    expect(await searchTokens(ctx.userId, 'file', fileId)).toBeNull();

    const audits = await auditRows(ctx.userId, 'hub.record_deleted');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_type: 'user', target_type: 'hub' });
    expect(audits[0]!.metadata).toEqual({ kind: 'person', notes: 1, files: 1, links: 1 });
    expect(JSON.stringify(audits[0])).not.toContain('acme');

    await expectCode(records.get(ctx, 'person', pid), 'not_found', 404);
  });

  it('writes name and domain markers for email-origin companies and projects only', async () => {
    const ctx = await setup();
    const mailCompany = await records.create(ctx, 'company', { name: 'Mail Co', domains: ['mailco.test'] });
    await q(`update hub_company set created_from = 'email' where id = $1`, [mailCompany.record.id]);
    await q(`update hub_company_domain set origin = 'email' where company_id = $1`, [mailCompany.record.id]);
    const userCompany = await records.create(ctx, 'company', { name: 'User Co', domains: ['userco.test'] });
    const mailProject = await records.create(ctx, 'project', { name: 'Mail Project' });
    await q(`update hub_project set created_from = 'email' where id = $1`, [mailProject.record.id]);
    const userProject = await records.create(ctx, 'project', { name: 'User Project' });

    for (const [kind, id] of [
      ['company', mailCompany.record.id],
      ['company', userCompany.record.id],
      ['project', mailProject.record.id],
      ['project', userProject.record.id],
    ] as const) {
      await records.remove(ctx, kind, id);
    }

    const m = await markers(ctx.userId);
    expect(m).toContain(markerKey.companyName('Mail Co'));
    expect(m).toContain(markerKey.companyDomain('mailco.test'));
    expect(m).toContain(markerKey.projectName('Mail Project'));
    expect(m).not.toContain(markerKey.companyName('User Co'));
    expect(m).not.toContain(markerKey.companyDomain('userco.test'));
    expect(m).not.toContain(markerKey.projectName('User Project'));
    expect(await auditRows(ctx.userId, 'hub.record_deleted')).toHaveLength(4);
  });
});

describe('list (FR-006)', () => {
  it('sorts by name after decrypting and by updated_at, both orders', async () => {
    const ctx = await setup();
    const bravo = await records.create(ctx, 'person', { name: 'bravo' });
    const alpha = await records.create(ctx, 'person', { name: 'Alpha' });
    const charlie = await records.create(ctx, 'person', { name: 'charlie' });
    await records.patch(ctx, 'person', bravo.record.id, { roleTitle: 'Last touched' });

    const byName = await records.list(ctx, 'person', {});
    expect(byName.items.map((i) => i.name)).toEqual(['Alpha', 'bravo', 'charlie']);
    expect(byName.nextCursor).toBeNull();
    const byNameDesc = await records.list(ctx, 'person', { sort: 'name', order: 'desc' });
    expect(byNameDesc.items.map((i) => i.name)).toEqual(['charlie', 'bravo', 'Alpha']);

    const byUpdated = await records.list(ctx, 'person', { sort: 'updated', order: 'desc' });
    expect(byUpdated.items.map((i) => i.id)).toEqual([bravo.record.id, charlie.record.id, alpha.record.id]);
    const byUpdatedAsc = await records.list(ctx, 'person', { sort: 'updated', order: 'asc' });
    expect(byUpdatedAsc.items.map((i) => i.id)).toEqual([alpha.record.id, charlie.record.id, bravo.record.id]);
  });

  it('paginates with default 25 and max 100', async () => {
    const ctx = await setup();
    for (let i = 0; i < 30; i += 1) await records.create(ctx, 'project', { name: `Project ${String(i).padStart(2, '0')}` });

    const first = await records.list(ctx, 'project', { sort: 'name', order: 'asc' });
    expect(first.items).toHaveLength(25);
    expect(first.items[0]!.name).toBe('Project 00');
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await records.list(ctx, 'project', { sort: 'name', order: 'asc', cursor: first.nextCursor! });
    expect(second.items.map((i) => i.name)).toEqual(['Project 25', 'Project 26', 'Project 27', 'Project 28', 'Project 29']);
    expect(second.nextCursor).toBeNull();

    const upd1 = await records.list(ctx, 'project', { sort: 'updated', limit: 20 });
    const upd2 = await records.list(ctx, 'project', { sort: 'updated', limit: 20, cursor: upd1.nextCursor! });
    expect(upd1.items).toHaveLength(20);
    expect(upd2.items).toHaveLength(10);
    expect(new Set([...upd1.items, ...upd2.items].map((i) => i.id)).size).toBe(30);

    expect((await records.list(ctx, 'project', { limit: 100 })).items).toHaveLength(30);
    await expectCode(records.list(ctx, 'project', { limit: 101 }), 'validation_failed', 422);
    await expectCode(records.list(ctx, 'project', { limit: 0 }), 'validation_failed', 422);
  });

  it('returns linkCounts (per other kind), noteCount and fileCount, and only the user records', async () => {
    const ctx = await setup();
    const person = await records.create(ctx, 'person', { name: 'P' });
    const company = await records.create(ctx, 'company', { name: 'C' });
    const project = await records.create(ctx, 'project', { name: 'X' });
    await seedLink(ctx.userId, 'person_company', { personId: person.record.id, companyId: company.record.id });
    await seedLink(ctx.userId, 'person_project', { personId: person.record.id, projectId: project.record.id });
    await seedNote(ctx.userId, 'person_id', person.record.id, 'person');
    await seedNote(ctx.userId, 'person_id', person.record.id, 'person');
    await seedFile(ctx.userId, 'person_id', person.record.id, 'person');
    const other = await setup();
    await records.create(other, 'person', { name: 'Foreign' });

    const { items } = await records.list(ctx, 'person', {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: person.record.id,
      name: 'P',
      linkCounts: { company: 1, project: 1 },
      noteCount: 2,
      fileCount: 1,
    });
    const companies = await records.list(ctx, 'company', {});
    expect(companies.items[0]).toMatchObject({ linkCounts: { person: 1, project: 0 }, noteCount: 0, fileCount: 0 });
  });
});

describe('isolation (FR-001)', () => {
  it('every read and write for another user id returns 404 not_found and changes nothing', async () => {
    const owner = await setup();
    const intruder = await setup();
    const person = await records.create(owner, 'person', { name: 'Secret', emails: ['s@acme.test'] });
    const company = await records.create(owner, 'company', { name: 'Secret Co', domains: ['secret.test'] });
    const pid = person.record.id;
    const cid = company.record.id;
    const emailId = (person.record as records.PersonView).emails[0]!.id;
    const domainId = (company.record as records.CompanyView).domains[0]!.id;

    await expectCode(records.get(intruder, 'person', pid), 'not_found', 404);
    await expectCode(records.deletePreview(intruder, 'person', pid), 'not_found', 404);
    await expectCode(records.patch(intruder, 'person', pid, { name: 'Pwned' }), 'not_found', 404);
    await expectCode(records.remove(intruder, 'person', pid), 'not_found', 404);
    await expectCode(records.addEmail(intruder, 'person', pid, { address: 'x@y.test' }), 'not_found', 404);
    await expectCode(records.removeEmail(intruder, 'person', pid, emailId), 'not_found', 404);
    await expectCode(records.addDomain(intruder, 'company', cid, { domain: 'y.test' }), 'not_found', 404);
    await expectCode(records.removeDomain(intruder, 'company', cid, domainId), 'not_found', 404);
    expect((await records.list(intruder, 'person', {})).items).toEqual([]);

    // Wrong kind for an existing id, and an email id of another record of the same user.
    await expectCode(records.get(owner, 'company', pid), 'not_found', 404);
    const other = await records.create(owner, 'person', { name: 'Other' });
    await expectCode(records.removeEmail(owner, 'person', other.record.id, emailId), 'not_found', 404);

    const row = await personRow(pid);
    expect(decrypt('user-content', row!.name_enc)).toBe('Secret');
    expect(await emailRows(pid)).toHaveLength(1);
    expect(await q('select 1 from hub_company_domain where id = $1', [domainId])).toHaveLength(1);
    expect(await q('select 1 from hub_sync_item where user_id = $1', [intruder.userId])).toHaveLength(0);
    expect(await q('select 1 from hub_search_doc where user_id = $1', [intruder.userId])).toHaveLength(0);
  });
});

describe('outbox and search index on every write', () => {
  it('create, patch and delete mark the record dirty and maintain hub_search_doc', async () => {
    const ctx = await setup();
    const person = await records.create(ctx, 'person', {
      name: 'Anna Nowak',
      roleTitle: 'Engineer',
      phone: '+48 600 700 800',
      description: 'Loves sailing',
      emails: ['anna@acme.test'],
    });
    const pid = person.record.id;
    expect(await syncRow(ctx.userId, 'person', pid)).toMatchObject({ version: 1, deleted: false, status: 'pending' });
    expect(enqueue).toHaveBeenCalledWith('hub.sync', { userId: ctx.userId }, expect.objectContaining({ jobId: `hubsync-${ctx.userId}` }));
    expectIndexed(await searchTokens(ctx.userId, 'person', pid), ctx.userId, [
      'Anna Nowak',
      'Engineer',
      'anna@acme.test',
      '+48 600 700 800',
      'Loves sailing',
    ]);

    await records.patch(ctx, 'person', pid, { name: 'Zofia Wright' });
    expect((await syncRow(ctx.userId, 'person', pid))!.version).toBe(2);
    const tokens = await searchTokens(ctx.userId, 'person', pid);
    expectIndexed(tokens, ctx.userId, ['Zofia Wright']);
    expect(tokens).not.toContain(indexTokens(ctx.userId, ['nowak']).at(-1));

    const company = await records.create(ctx, 'company', {
      name: 'Acme',
      website: 'https://acme.test',
      industry: 'Robotics',
      domains: ['acme.test'],
    });
    expectIndexed(await searchTokens(ctx.userId, 'company', company.record.id), ctx.userId, [
      'Acme',
      'acme.test',
      'Robotics',
    ]);
    expect(await syncRow(ctx.userId, 'company', company.record.id)).toMatchObject({ version: 1 });

    const project = await records.create(ctx, 'project', { name: 'Relaunch', status: 'active', description: 'Website' });
    expectIndexed(await searchTokens(ctx.userId, 'project', project.record.id), ctx.userId, [
      'Relaunch',
      'active',
      'Website',
    ]);
    await records.remove(ctx, 'project', project.record.id);
    expect(await syncRow(ctx.userId, 'project', project.record.id)).toMatchObject({ deleted: true });
    expect(await searchTokens(ctx.userId, 'project', project.record.id)).toBeNull();
  });

  it('a rename marks linked records dirty too (markRecordTree)', async () => {
    const ctx = await setup();
    const person = await records.create(ctx, 'person', { name: 'P' });
    const company = await records.create(ctx, 'company', { name: 'C' });
    await seedLink(ctx.userId, 'person_company', { personId: person.record.id, companyId: company.record.id });
    const before = (await syncRow(ctx.userId, 'company', company.record.id))!.version;
    await records.patch(ctx, 'person', person.record.id, { name: 'P renamed' });
    expect((await syncRow(ctx.userId, 'company', company.record.id))!.version).toBeGreaterThan(before);
  });
});

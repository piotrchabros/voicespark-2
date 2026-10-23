import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import { markerKey } from '@voicespark/core/hub/fingerprint';
import * as links from '@voicespark/core/services/hub/links';
import * as records from '@voicespark/core/services/hub/records';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US2 links (T053; data-model.md "hub_link"; contracts/http-api.md "Links"; contracts/memory-store-hub.md "Outbox";
// FR-007, FR-016, FR-017).
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
process.env.HUB_FILES_DIR ??= mkdtempSync(join(tmpdir(), 'hub-links-'));
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

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

interface World {
  ctx: ServiceContext;
  personId: string;
  companyId: string;
  projectId: string;
}

async function world(): Promise<World> {
  const ctx: ServiceContext = { userId: await createUser(), role: 'user' };
  const person = (await records.create(ctx, 'person', { name: 'Anna Nowak' })).record.id;
  const company = (await records.create(ctx, 'company', { name: 'Acme' })).record.id;
  const project = (await records.create(ctx, 'project', { name: 'Apollo' })).record.id;
  return { ctx, personId: person, companyId: company, projectId: project };
}

async function linkRow(id: string) {
  const [r] = await q<{ role_enc: string | null; role_owner_set: boolean; origin: string }>(
    'select role_enc, role_owner_set, origin from hub_link where id = $1',
    [id],
  );
  return r;
}

async function markers(userId: string): Promise<string[]> {
  const rows = await q<{ key_hash: string }>('select key_hash from hub_block_marker where user_id = $1', [userId]);
  return rows.map((r) => r.key_hash);
}

async function syncRows(userId: string): Promise<Map<string, { deleted: boolean; version: number }>> {
  const rows = await q<{ doc_id: string; deleted: boolean; version: number }>(
    'select doc_id, deleted, version::int as version from hub_sync_item where user_id = $1',
    [userId],
  );
  return new Map(rows.map((r) => [r.doc_id, r]));
}

async function seedNote(userId: string, col: string, ownerId: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_note (user_id, ${col}, title_enc, body_json_enc) values ($1, $2, 'x', 'x') returning id`,
    [userId, ownerId],
  );
  return r!.id;
}

async function seedFile(userId: string, col: string, ownerId: string): Promise<string> {
  const [r] = await q<{ id: string }>(
    `insert into hub_file (user_id, ${col}, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id)
     values ($1, $2, 'x', 'text/plain', 'txt', 1, $3, gen_random_uuid(), 'k1') returning id`,
    [userId, ownerId, H('d')],
  );
  return r!.id;
}

async function seedSummary(userId: string, personId: string): Promise<string> {
  const [t] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, summary_enc, summary_version) values ($1, $2, 'x', 1) returning id`,
    [userId, H('e')],
  );
  await q(`insert into hub_thread_record (user_id, thread_id, person_id) values ($1, $2, $3)`, [
    userId,
    t!.id,
    personId,
  ]);
  return t!.id;
}

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('create', () => {
  it('creates all three kinds, user origin, encrypted role', async () => {
    const w = await world();
    const pc = await links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId, role: 'CTO' });
    expect(pc.link).toMatchObject({
      kind: 'person_company',
      personId: w.personId,
      companyId: w.companyId,
      projectId: null,
      role: 'CTO',
      origin: 'user',
    });
    const row = await linkRow(pc.link.id);
    expect(row?.role_enc).not.toBeNull();
    expect(row?.role_enc).not.toContain('CTO');
    expect(decrypt('user-content', row!.role_enc!)).toBe('CTO');
    expect(row?.origin).toBe('user');

    const pp = await links.create(w.ctx, { kind: 'person_project', personId: w.personId, projectId: w.projectId });
    expect(pp.link).toMatchObject({ kind: 'person_project', personId: w.personId, projectId: w.projectId, companyId: null, role: null });
    const cp = await links.create(w.ctx, { kind: 'company_project', companyId: w.companyId, projectId: w.projectId });
    expect(cp.link).toMatchObject({ kind: 'company_project', companyId: w.companyId, projectId: w.projectId, personId: null });
  });

  it('answers 404 for a foreign or missing record', async () => {
    const w = await world();
    const other = await world();
    await expectCode(
      links.create(w.ctx, { kind: 'person_company', personId: other.personId, companyId: w.companyId }),
      'not_found',
      404,
    );
    await expectCode(
      links.create(w.ctx, {
        kind: 'person_company',
        personId: w.personId,
        companyId: '00000000-0000-4000-8000-000000000000',
      }),
      'not_found',
      404,
    );
    expect(await q('select 1 from hub_link where user_id = $1', [w.ctx.userId])).toHaveLength(0);
  });

  it('answers 409 invalid_link when the ids do not match the kind', async () => {
    const w = await world();
    // missing end
    await expectCode(links.create(w.ctx, { kind: 'person_company', personId: w.personId }), 'invalid_link', 409);
    // wrong pair for the kind
    await expectCode(
      links.create(w.ctx, { kind: 'person_company', personId: w.personId, projectId: w.projectId }),
      'invalid_link',
      409,
    );
    // an extra third id
    await expectCode(
      links.create(w.ctx, {
        kind: 'person_company',
        personId: w.personId,
        companyId: w.companyId,
        projectId: w.projectId,
      }),
      'invalid_link',
      409,
    );
    // same-kind pair: both ends are people
    const second = (await records.create(w.ctx, 'person', { name: 'Jan Kowalski' })).record.id;
    await expectCode(
      links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: second }),
      'invalid_link',
      409,
    );
    expect(await q('select 1 from hub_link where user_id = $1', [w.ctx.userId])).toHaveLength(0);
  });

  it('answers 409 link_exists with details.linkId for a duplicate pair', async () => {
    const w = await world();
    const first = await links.create(w.ctx, { kind: 'person_project', personId: w.personId, projectId: w.projectId });
    const err = await expectCode(
      links.create(w.ctx, { kind: 'person_project', personId: w.personId, projectId: w.projectId, role: 'Lead' }),
      'link_exists',
      409,
    );
    expect(err.details).toEqual({ linkId: first.link.id });
    expect(await q('select 1 from hub_link where user_id = $1', [w.ctx.userId])).toHaveLength(1);
  });

  it('rejects an unknown kind or a malformed id with validation_failed', async () => {
    const w = await world();
    await expectCode(
      links.create(w.ctx, { kind: 'nope', personId: w.personId, companyId: w.companyId } as never),
      'validation_failed',
    );
    await expectCode(
      links.create(w.ctx, { kind: 'person_company', personId: 'x', companyId: w.companyId }),
      'validation_failed',
    );
  });

  it('limits the role to 100 characters and inspects it', async () => {
    const w = await world();
    await expectCode(
      links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId, role: 'r'.repeat(101) }),
      'validation_failed',
    );
    const ok = await links.create(w.ctx, {
      kind: 'person_company',
      personId: w.personId,
      companyId: w.companyId,
      role: 'r'.repeat(100),
    });
    expect(ok.link.role).toHaveLength(100);

    const w2 = await world();
    const res = await links.create(w2.ctx, {
      kind: 'person_company',
      personId: w2.personId,
      companyId: w2.companyId,
      role: `Buyer ${CARD}`,
    });
    expect(res.link.role).not.toContain(CARD);
    expect(res.redactedValues).toBeGreaterThan(0);
    const row = await linkRow(res.link.id);
    expect(decrypt('user-content', row!.role_enc!)).not.toContain(CARD);
  });
});

describe('setRole', () => {
  it('sets the role, marks it owner-set, and null clears it', async () => {
    const w = await world();
    const { link } = await links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId });
    expect((await linkRow(link.id))?.role_owner_set).toBe(false);

    const set = await links.setRole(w.ctx, link.id, 'Founder');
    expect(set.link.role).toBe('Founder');
    expect(await linkRow(link.id)).toMatchObject({ role_owner_set: true });
    expect(decrypt('user-content', (await linkRow(link.id))!.role_enc!)).toBe('Founder');

    const cleared = await links.setRole(w.ctx, link.id, null);
    expect(cleared.link.role).toBeNull();
    expect(await linkRow(link.id)).toMatchObject({ role_enc: null, role_owner_set: true });
  });

  it('validates and inspects the role; 404 for a foreign link', async () => {
    const w = await world();
    const other = await world();
    const { link } = await links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId });
    await expectCode(links.setRole(w.ctx, link.id, 'r'.repeat(101)), 'validation_failed');
    const res = await links.setRole(w.ctx, link.id, `Pays by ${CARD}`);
    expect(res.link.role).not.toContain(CARD);
    expect(res.redactedValues).toBeGreaterThan(0);
    await expectCode(links.setRole(other.ctx, link.id, 'x'), 'not_found', 404);
    await expectCode(links.setRole(w.ctx, '00000000-0000-4000-8000-000000000000', 'x'), 'not_found', 404);
  });
});

describe('listForRecord and remove', () => {
  it('returns the link from both records', async () => {
    const w = await world();
    const { link } = await links.create(w.ctx, {
      kind: 'person_company',
      personId: w.personId,
      companyId: w.companyId,
      role: 'CTO',
    });
    const fromPerson = await links.listForRecord(w.ctx, 'person', w.personId);
    const fromCompany = await links.listForRecord(w.ctx, 'company', w.companyId);
    expect(fromPerson).toHaveLength(1);
    expect(fromPerson[0]).toMatchObject({ link: { id: link.id, role: 'CTO' }, other: { kind: 'company', id: w.companyId, name: 'Acme' } });
    expect(fromCompany[0]).toMatchObject({ link: { id: link.id }, other: { kind: 'person', id: w.personId, name: 'Anna Nowak' } });
    expect(await links.listForRecord(w.ctx, 'project', w.projectId)).toEqual([]);
    // the record detail shows it too
    const detail = await records.get(w.ctx, 'person', w.personId);
    expect(detail.links.map((l) => l.link.id)).toEqual([link.id]);
  });

  it('answers 404 listing a foreign record', async () => {
    const w = await world();
    const other = await world();
    await expectCode(links.listForRecord(w.ctx, 'person', other.personId), 'not_found', 404);
  });

  it('deletes a user-origin link without a marker; foreign ids are 404', async () => {
    const w = await world();
    const other = await world();
    const { link } = await links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId });
    await expectCode(links.remove(other.ctx, link.id), 'not_found', 404);
    await links.remove(w.ctx, link.id);
    expect(await linkRow(link.id)).toBeUndefined();
    expect(await markers(w.ctx.userId)).toEqual([]);
    await expectCode(links.remove(w.ctx, link.id), 'not_found', 404);
  });

  it.each([
    ['person_company', (w: World) => [w.personId, w.companyId], (w: World) => ({ person_id: w.personId, company_id: w.companyId })],
    ['person_project', (w: World) => [w.personId, w.projectId], (w: World) => ({ person_id: w.personId, project_id: w.projectId })],
    ['company_project', (w: World) => [w.companyId, w.projectId], (w: World) => ({ company_id: w.companyId, project_id: w.projectId })],
  ] as const)('writes link:%s:{idA}:{idB} for an email-origin link', async (kind, ids, cols) => {
    const w = await world();
    const c = cols(w) as Record<string, string>;
    const [r] = await q<{ id: string }>(
      `insert into hub_link (user_id, kind, person_id, company_id, project_id, origin)
       values ($1, $2, $3, $4, $5, 'email') returning id`,
      [w.ctx.userId, kind, c.person_id ?? null, c.company_id ?? null, c.project_id ?? null],
    );
    await links.remove(w.ctx, r!.id);
    const [a, b] = ids(w);
    expect(await markers(w.ctx.userId)).toEqual([markerKey.link(kind, a!, b!)]);
  });
});

describe('outbox fan-out (FR-007)', () => {
  async function fixture() {
    const w = await world();
    const personNote = await seedNote(w.ctx.userId, 'person_id', w.personId);
    const companyNote = await seedNote(w.ctx.userId, 'company_id', w.companyId);
    const personFile = await seedFile(w.ctx.userId, 'person_id', w.personId);
    const companyFile = await seedFile(w.ctx.userId, 'company_id', w.companyId);
    const summary = await seedSummary(w.ctx.userId, w.personId);
    const docs = [
      `hub_person_${w.personId}`,
      `hub_company_${w.companyId}`,
      `hub_note_${personNote}`,
      `hub_note_${companyNote}`,
      `hub_file_${personFile}`,
      `hub_file_${companyFile}`,
      `hub_summary_${summary}`,
    ];
    await q('delete from hub_sync_item where user_id = $1', [w.ctx.userId]);
    return { w, docs, projectDoc: `hub_project_${w.projectId}` };
  }

  async function expectDirty(userId: string, docs: string[]) {
    const rows = await syncRows(userId);
    for (const d of docs) expect(rows.get(d), d).toMatchObject({ deleted: false });
  }

  it('create marks both records, their notes, files and summaries dirty', async () => {
    const { w, docs, projectDoc } = await fixture();
    await links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId });
    await expectDirty(w.ctx.userId, docs);
    expect((await syncRows(w.ctx.userId)).has(projectDoc)).toBe(false);
  });

  it('role change marks them dirty', async () => {
    const { w, docs } = await fixture();
    const { link } = await links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId });
    await q('delete from hub_sync_item where user_id = $1', [w.ctx.userId]);
    await links.setRole(w.ctx, link.id, 'CTO');
    await expectDirty(w.ctx.userId, docs);
  });

  it('delete marks them dirty, not as tombstones', async () => {
    const { w, docs } = await fixture();
    const { link } = await links.create(w.ctx, { kind: 'person_company', personId: w.personId, companyId: w.companyId });
    await q('delete from hub_sync_item where user_id = $1', [w.ctx.userId]);
    await links.remove(w.ctx, link.id);
    await expectDirty(w.ctx.userId, docs);
  });
});

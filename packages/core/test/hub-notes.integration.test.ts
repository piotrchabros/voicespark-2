import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import type { HubNode, HubNoteDoc } from '@voicespark/core/hub/content-schema';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import { getClassifier } from '@voicespark/core/services/inspection';
import * as notes from '@voicespark/core/services/hub/notes';
import * as records from '@voicespark/core/services/hub/records';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US2 notes (T054, test-first inspection site; contracts/http-api.md "Notes"; data-model.md "hub_note";
// FR-008, FR-028, Principle VI). Note text and hrefs pass inspectSegments under the full policy before storage.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

vi.mock('@voicespark/core/services/inspection', async (importOriginal) => {
  const real = await importOriginal<typeof import('@voicespark/core/services/inspection')>();
  return { ...real, getClassifier: vi.fn(real.getClassifier) };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.HUB_FILES_DIR ??= mkdtempSync(join(tmpdir(), 'hub-notes-'));
process.env.NODE_ENV ??= 'test';

const CARD = '4111 1111 1111 1111';
const PASSWORD = 'Xk9mQ2vLp7';

const text = (t: string, marks?: HubNode['marks']): HubNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: HubNode[]): HubNode => ({ type: 'paragraph', content });
const doc = (...content: HubNode[]): HubNoteDoc => ({ type: 'doc', content });

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

async function setup(): Promise<{ ctx: ServiceContext; personId: string }> {
  const ctx: ServiceContext = { userId: await createUser(), role: 'user' };
  const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak' });
  return { ctx, personId: record.id };
}

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function noteRows(userId: string) {
  return q<{ id: string; person_id: string | null; title_enc: string; body_json_enc: string; redacted_values: number }>(
    'select * from hub_note where user_id = $1',
    [userId],
  );
}

async function syncRow(userId: string, type: string, id: string) {
  const [r] = await q<{ version: number; deleted: boolean; status: string }>(
    `select version::int as version, deleted, status from hub_sync_item where user_id = $1 and doc_id = $2`,
    [userId, `hub_${type}_${id}`],
  );
  return r;
}

async function searchDoc(userId: string, id: string) {
  const [r] = await q<{ tokens: string[]; owner_kind: string | null; owner_id: string | null }>(
    `select tokens, owner_kind, owner_id from hub_search_doc where user_id = $1 and item_type = 'note' and item_id = $2`,
    [userId, id],
  );
  return r ? { ...r, tokens: r.tokens.map((t) => t.trim()) } : null;
}

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('create', () => {
  it('stores title and body encrypted, indexes title and plain text, marks note and owner dirty', async () => {
    const { ctx, personId } = await setup();
    const before = (await syncRow(ctx.userId, 'person', personId))!.version;
    const body = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Kickoff')] },
      para(text('Budget discussed with '), text('Acme', [{ type: 'link', attrs: { href: 'https://acme.test' } }])),
    );
    const note = await notes.create(ctx, 'person', personId, { title: 'Meeting minutes', body });
    expect(note).toMatchObject({ title: 'Meeting minutes', body, redactedValues: 0 });
    expect(note.sync).toEqual({ status: 'pending', lastSyncedAt: null });
    expect(typeof note.createdAt).toBe('string');

    const [row] = await noteRows(ctx.userId);
    expect(row!.person_id).toBe(personId);
    expect(row!.title_enc).not.toContain('Meeting');
    expect(decrypt('user-content', row!.title_enc)).toBe('Meeting minutes');
    expect(JSON.parse(decrypt('user-content', row!.body_json_enc))).toEqual(body);

    const sd = await searchDoc(ctx.userId, note.id);
    expect(sd).toMatchObject({ owner_kind: 'person', owner_id: personId });
    expect(sd!.tokens).toEqual(expect.arrayContaining(indexTokens(ctx.userId, ['minutes', 'Kickoff', 'Budget', 'Acme'])));

    expect(await syncRow(ctx.userId, 'note', note.id)).toMatchObject({ deleted: false, status: 'pending' });
    expect((await syncRow(ctx.userId, 'person', personId))!.version).toBeGreaterThan(before);
  });

  it('accepts an empty title and rejects one over 300 chars', async () => {
    const { ctx, personId } = await setup();
    const note = await notes.create(ctx, 'person', personId, { title: '', body: doc(para(text('x'))) });
    expect(note.title).toBe('');
    await expectCode(
      notes.create(ctx, 'person', personId, { title: 'a'.repeat(301), body: doc(para(text('x'))) }),
      'validation_failed',
      422,
    );
  });

  it.each([
    ['an unknown node', doc({ type: 'image', attrs: { src: 'https://x.test/a.png' } } as unknown as HubNode)],
    ['a script node', doc({ type: 'script', content: [text('alert(1)')] } as unknown as HubNode)],
    ['a javascript: href', doc(para(text('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])))],
    ['more than 100,000 chars', doc(para(text('a'.repeat(60_000))), para(text('b'.repeat(40_001))))],
    ['more than 1 MB serialised', doc(...Array.from({ length: 30_000 }, () => para(text('x', [{ type: 'bold' }, { type: 'italic' }]))))],
    ['not a doc', { type: 'paragraph', content: [] } as unknown as HubNoteDoc],
  ])('rejects %s with 422 validation_failed, nothing stored', async (_label, body) => {
    const { ctx, personId } = await setup();
    await expectCode(notes.create(ctx, 'person', personId, { title: 't', body }), 'validation_failed', 422);
    expect(await noteRows(ctx.userId)).toHaveLength(0);
  });

  it('redacts a password and keeps heading and checklist (US2 AS7)', async () => {
    const { ctx, personId } = await setup();
    const body = doc(
      { type: 'heading', attrs: { level: 1 }, content: [text('Server access')] },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [para(text('Ask for VPN'))] },
          { type: 'taskItem', attrs: { checked: false }, content: [para(text(`my password: ${PASSWORD}`))] },
        ],
      },
      para(text(`Card ${CARD}`)),
    );
    const note = await notes.create(ctx, 'person', personId, { title: 'Access', body });
    expect(note.redactedValues).toBeGreaterThanOrEqual(2);
    const json = JSON.stringify(note.body);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain('4111');
    expect(json).toMatch(/\[excluded: /);
    expect(note.body.content[0]).toEqual(body.content[0]);
    expect(note.body.content[1]!.type).toBe('taskList');
    expect(note.body.content[1]!.content).toHaveLength(2);
    expect(note.body.content[1]!.content![0]).toEqual(body.content[1]!.content![0]);

    const [row] = await noteRows(ctx.userId);
    expect(row!.redacted_values).toBe(note.redactedValues);
    const stored = decrypt('user-content', row!.body_json_enc);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain('4111');
  });

  it('inspects the title and link hrefs', async () => {
    const { ctx, personId } = await setup();
    const note = await notes.create(ctx, 'person', personId, {
      title: `Card ${CARD}`,
      body: doc(para(text('link', [{ type: 'link', attrs: { href: `https://pay.test/?card=${CARD.replaceAll(' ', '')}` } }]))),
    });
    expect(note.title).not.toContain('4111');
    expect(JSON.stringify(note.body)).not.toContain('4111111111111111');
    expect(note.redactedValues).toBeGreaterThanOrEqual(2);
  });

  it('a wholly excluded note -> 422 note_excluded with details.category, nothing stored', async () => {
    const { ctx, personId } = await setup();
    await q(`insert into exclusion_rule (user_id, type, value) values ($1, 'keyword', 'confidential')`, [ctx.userId]);
    const err = await expectCode(
      notes.create(ctx, 'person', personId, { title: 't', body: doc(para(text('This is confidential'))) }),
      'note_excluded',
      422,
    );
    expect(err.details?.category).toBe('user_rule');
    expect(await noteRows(ctx.userId)).toHaveLength(0);
    expect(await q(`select 1 from hub_search_doc where user_id = $1 and item_type = 'note'`, [ctx.userId])).toHaveLength(0);
  });

  it('an inspection failure -> 503 inspection_unavailable, nothing stored (fail-closed)', async () => {
    const { ctx, personId } = await setup();
    vi.mocked(getClassifier).mockReturnValueOnce({
      classify: async () => {
        throw new Error('classifier down');
      },
    } as unknown as ReturnType<typeof getClassifier>);
    await expectCode(
      notes.create(ctx, 'person', personId, { title: 't', body: doc(para(text('hello'))) }),
      'inspection_unavailable',
      503,
    );
    expect(await noteRows(ctx.userId)).toHaveLength(0);
    expect(await syncRow(ctx.userId, 'note', '00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('works for companies and projects', async () => {
    const { ctx } = await setup();
    const { record: company } = await records.create(ctx, 'company', { name: 'Acme' });
    const { record: project } = await records.create(ctx, 'project', { name: 'Apollo' });
    const a = await notes.create(ctx, 'company', company.id, { title: 'c', body: doc(para(text('x'))) });
    const b = await notes.create(ctx, 'project', project.id, { title: 'p', body: doc(para(text('y'))) });
    expect((await searchDoc(ctx.userId, a.id))).toMatchObject({ owner_kind: 'company', owner_id: company.id });
    expect((await searchDoc(ctx.userId, b.id))).toMatchObject({ owner_kind: 'project', owner_id: project.id });
  });
});

describe('patch', () => {
  it('keeps only the latest version, re-indexes and marks dirty', async () => {
    const { ctx, personId } = await setup();
    const note = await notes.create(ctx, 'person', personId, { title: 'Draft', body: doc(para(text('alpha'))) });
    const v1 = (await syncRow(ctx.userId, 'note', note.id))!.version;
    const patched = await notes.patch(ctx, note.id, { title: 'Final', body: doc(para(text('omega'))) });
    expect(patched).toMatchObject({ id: note.id, title: 'Final', body: doc(para(text('omega'))) });

    const rows = await noteRows(ctx.userId);
    expect(rows).toHaveLength(1);
    expect(decrypt('user-content', rows[0]!.title_enc)).toBe('Final');
    expect(decrypt('user-content', rows[0]!.body_json_enc)).not.toContain('alpha');

    const sd = await searchDoc(ctx.userId, note.id);
    expect(sd!.tokens).toEqual(expect.arrayContaining(indexTokens(ctx.userId, ['Final', 'omega'])));
    expect(sd!.tokens).not.toEqual(expect.arrayContaining(indexTokens(ctx.userId, ['alpha'])));
    expect((await syncRow(ctx.userId, 'note', note.id))!.version).toBeGreaterThan(v1);

    const titleOnly = await notes.patch(ctx, note.id, { title: 'Renamed' });
    expect(titleOnly.body).toEqual(doc(para(text('omega'))));
  });

  it('validates and inspects the patch; failures leave the note unchanged', async () => {
    const { ctx, personId } = await setup();
    const note = await notes.create(ctx, 'person', personId, { title: 'Keep', body: doc(para(text('kept'))) });
    await expectCode(notes.patch(ctx, note.id, {}), 'validation_failed', 422);
    await expectCode(
      notes.patch(ctx, note.id, { body: doc({ type: 'script' } as unknown as HubNode) }),
      'validation_failed',
      422,
    );
    vi.mocked(getClassifier).mockReturnValueOnce({
      classify: async () => {
        throw new Error('down');
      },
    } as unknown as ReturnType<typeof getClassifier>);
    await expectCode(notes.patch(ctx, note.id, { title: 'Lost' }), 'inspection_unavailable', 503);
    await q(`insert into exclusion_rule (user_id, type, value) values ($1, 'keyword', 'confidential')`, [ctx.userId]);
    await expectCode(
      notes.patch(ctx, note.id, { body: doc(para(text('confidential plan'))) }),
      'note_excluded',
      422,
    );
    const got = await notes.get(ctx, note.id);
    expect(got).toMatchObject({ title: 'Keep', body: doc(para(text('kept'))) });

    const redacted = await notes.patch(ctx, note.id, { body: doc(para(text(`Card ${CARD}`))) });
    expect(redacted.redactedValues).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(redacted.body)).not.toContain('4111');
  });
});

describe('get, list, remove', () => {
  it('lists newest change first with a cursor', async () => {
    const { ctx, personId } = await setup();
    const a = await notes.create(ctx, 'person', personId, { title: 'A', body: doc(para(text('a'))) });
    const b = await notes.create(ctx, 'person', personId, { title: 'B', body: doc(para(text('b'))) });
    const c = await notes.create(ctx, 'person', personId, { title: 'C', body: doc(para(text('c'))) });
    await notes.patch(ctx, a.id, { title: 'A2' });

    const all = await notes.list(ctx, 'person', personId, {});
    expect(all.items.map((n) => n.id)).toEqual([a.id, c.id, b.id]);
    expect(all.items[0]).toMatchObject({ title: 'A2', body: doc(para(text('a'))) });
    expect(all.nextCursor).toBeNull();

    const p1 = await notes.list(ctx, 'person', personId, { limit: 2 });
    expect(p1.items.map((n) => n.id)).toEqual([a.id, c.id]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await notes.list(ctx, 'person', personId, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((n) => n.id)).toEqual([b.id]);
    expect(p2.nextCursor).toBeNull();
  });

  it('get returns the note with sync', async () => {
    const { ctx, personId } = await setup();
    const note = await notes.create(ctx, 'person', personId, { title: 'T', body: doc(para(text('x'))) });
    const got = await notes.get(ctx, note.id);
    expect(got).toMatchObject({ id: note.id, title: 'T', redactedValues: 0, sync: { status: 'pending' } });
  });

  it('remove deletes the note, its search row, tombstones it and marks the owner dirty', async () => {
    const { ctx, personId } = await setup();
    const note = await notes.create(ctx, 'person', personId, { title: 'T', body: doc(para(text('x'))) });
    const ownerBefore = (await syncRow(ctx.userId, 'person', personId))!.version;
    await notes.remove(ctx, note.id);
    expect(await noteRows(ctx.userId)).toHaveLength(0);
    expect(await searchDoc(ctx.userId, note.id)).toBeNull();
    expect(await syncRow(ctx.userId, 'note', note.id)).toMatchObject({ deleted: true });
    expect((await syncRow(ctx.userId, 'person', personId))!.version).toBeGreaterThan(ownerBefore);
    await expectCode(notes.get(ctx, note.id), 'not_found', 404);
  });

  it("another user's note or record -> 404 (FR-008)", async () => {
    const { ctx, personId } = await setup();
    const other = await setup();
    const note = await notes.create(ctx, 'person', personId, { title: 'Mine', body: doc(para(text('x'))) });
    await expectCode(notes.get(other.ctx, note.id), 'not_found', 404);
    await expectCode(notes.patch(other.ctx, note.id, { title: 'Hijack' }), 'not_found', 404);
    await expectCode(notes.remove(other.ctx, note.id), 'not_found', 404);
    await expectCode(notes.list(other.ctx, 'person', personId, {}), 'not_found', 404);
    await expectCode(
      notes.create(other.ctx, 'person', personId, { title: 'x', body: doc(para(text('x'))) }),
      'not_found',
      404,
    );
    await expectCode(notes.get(ctx, 'not-a-uuid'), 'not_found', 404);
    expect((await notes.get(ctx, note.id)).title).toBe('Mine');
    expect(await noteRows(other.ctx.userId)).toHaveLength(0);
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool, withTransaction } from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import { encrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import type { HubNoteDoc } from '@voicespark/core/hub/content-schema';
import { indexTokens, queryTokens } from '@voicespark/core/hub/search-tokens';
import * as files from '@voicespark/core/services/hub/files';
import * as notes from '@voicespark/core/services/hub/notes';
import * as records from '@voicespark/core/services/hub/records';
import { search, type SearchInput } from '@voicespark/core/services/hub/search';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US5 search over the blind token index (T088; contracts/hub-search.md "Query", "Results and snippets", "Tests";
// FR-001, FR-011, SC-003). Content stays encrypted; candidates come from `tokens @>` and are verified after decrypt.
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
process.env.HUB_FILES_DIR ??= mkdtempSync(join(tmpdir(), 'hub-search-'));
process.env.NODE_ENV ??= 'test';

const SC_TIMINGS_FILE = fileURLToPath(new URL('../test-results/sc-timings.json', import.meta.url));

const doc = (...paragraphs: string[]): HubNoteDoc => ({
  type: 'doc',
  content: paragraphs.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
});

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

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

async function newUser(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

async function person(ctx: ServiceContext, name: string, extra: Partial<records.PersonInput> = {}): Promise<string> {
  return (await records.create(ctx, 'person', { name, ...extra })).record.id;
}

const ids = async (ctx: ServiceContext, query: string, opts: Omit<SearchInput, 'q'> = {}) =>
  (await search(ctx, { q: query, ...opts })).items.map((i) => i.id);

async function searchDocCount(userId: string, itemId: string): Promise<number> {
  const [r] = await q<{ n: number }>('select count(*)::int as n from hub_search_doc where user_id = $1 and item_id = $2', [
    userId,
    itemId,
  ]);
  return r!.n;
}

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

// ---------------------------------------------------------------------------------------------------------------
// Raw SQL seeding (fixtures must not depend on the services under test; also fast enough for 10,000 items)

const hex64 = () => randomBytes(32).toString('hex');

async function insertRows(table: string, cols: string[], casts: string[], rows: unknown[][]): Promise<void> {
  const BATCH = 400;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const values = chunk.map((row) => {
      const ph = row.map((v, j) => {
        params.push(v);
        return `$${params.length}${casts[j] ? `::${casts[j]}` : ''}`;
      });
      return `(${ph.join(', ')})`;
    });
    await getPool().query(`insert into ${table} (${cols.join(', ')}) values ${values.join(', ')}`, params);
  }
}

interface SeedDoc {
  itemType: 'person' | 'company' | 'project' | 'note' | 'file';
  itemId: string;
  ownerKind: string | null;
  ownerId: string | null;
  tokens: string[];
  updatedAt: Date;
}

async function insertSearchDocs(userId: string, docs: SeedDoc[]): Promise<void> {
  await insertRows(
    'hub_search_doc',
    ['user_id', 'item_type', 'item_id', 'owner_kind', 'owner_id', 'tokens', 'updated_at'],
    ['uuid', '', 'uuid', '', 'uuid', 'char(16)[]', 'timestamptz'],
    docs.map((d) => [userId, d.itemType, d.itemId, d.ownerKind, d.ownerId, d.tokens, d.updatedAt]),
  );
}

async function seedPeople(userId: string, names: string[], at: (i: number) => Date, tokens: (name: string) => string[]) {
  const rows = names.map((name, i) => ({ id: randomUUID(), name, updatedAt: at(i) }));
  await insertRows(
    'hub_person',
    ['id', 'user_id', 'name_enc', 'name_key', 'match_key', 'created_at', 'updated_at'],
    ['uuid', 'uuid', '', '', '', 'timestamptz', 'timestamptz'],
    rows.map((r) => [r.id, userId, encrypt('user-content', r.name), hex64(), hex64(), r.updatedAt, r.updatedAt]),
  );
  await insertSearchDocs(
    userId,
    rows.map((r) => ({ itemType: 'person', itemId: r.id, ownerKind: null, ownerId: null, tokens: tokens(r.name), updatedAt: r.updatedAt })),
  );
  return rows.map((r) => r.id);
}

async function seedNotes(
  userId: string,
  ownerId: string,
  items: { title: string; body: string; updatedAt: Date; tokens: string[] }[],
): Promise<string[]> {
  const rows = items.map((it) => ({ ...it, id: randomUUID() }));
  await insertRows(
    'hub_note',
    ['id', 'user_id', 'person_id', 'title_enc', 'body_json_enc', 'created_at', 'updated_at'],
    ['uuid', 'uuid', 'uuid', '', '', 'timestamptz', 'timestamptz'],
    rows.map((r) => [
      r.id,
      userId,
      ownerId,
      encrypt('user-content', r.title),
      encrypt('user-content', JSON.stringify(doc(r.body))),
      r.updatedAt,
      r.updatedAt,
    ]),
  );
  await insertSearchDocs(
    userId,
    rows.map((r) => ({ itemType: 'note', itemId: r.id, ownerKind: 'person', ownerId, tokens: r.tokens, updatedAt: r.updatedAt })),
  );
  return rows.map((r) => r.id);
}

async function seedFiles(
  userId: string,
  ownerId: string,
  items: { name: string; text: string; updatedAt: Date; tokens: string[] }[],
): Promise<string[]> {
  const rows = items.map((it) => ({ ...it, id: randomUUID() }));
  await insertRows(
    'hub_file',
    [
      'id',
      'user_id',
      'person_id',
      'name_enc',
      'mime_type',
      'extension',
      'size_bytes',
      'sha256',
      'storage_key',
      'key_id',
      'extraction_status',
      'extracted_text_enc',
      'created_at',
      'updated_at',
    ],
    ['uuid', 'uuid', 'uuid', '', '', '', '', '', 'uuid', '', '', '', 'timestamptz', 'timestamptz'],
    rows.map((r) => [
      r.id,
      userId,
      ownerId,
      encrypt('user-content', r.name),
      'text/plain',
      'txt',
      r.text.length,
      hex64(),
      randomUUID(),
      'k1',
      'extracted',
      encrypt('user-content', r.text),
      r.updatedAt,
      r.updatedAt,
    ]),
  );
  await insertSearchDocs(
    userId,
    rows.map((r) => ({ itemType: 'file', itemId: r.id, ownerKind: 'person', ownerId, tokens: r.tokens, updatedAt: r.updatedAt })),
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------------------------

describe('query', () => {
  it('rejects q outside 1..200 chars and a bad limit or cursor with 422 validation_failed', async () => {
    const ctx = await newUser();
    await expectCode(search(ctx, { q: '' }), 'validation_failed', 422);
    await expectCode(search(ctx, { q: 'x'.repeat(201) }), 'validation_failed', 422);
    await expectCode(search(ctx, { q: 'ok', limit: 0 }), 'validation_failed', 422);
    await expectCode(search(ctx, { q: 'ok', limit: 101 }), 'validation_failed', 422);
    await expectCode(search(ctx, { q: 'ok', cursor: 'not-a-cursor' }), 'validation_failed', 422);
    await expectCode(search(ctx, { q: 'ok', types: ['email' as 'person'] }), 'validation_failed', 422);
    await expect(search(ctx, { q: 'x'.repeat(200) })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('a query with no usable token returns an empty list', async () => {
    const ctx = await newUser();
    await person(ctx, 'A B');
    await expect(search(ctx, { q: 'a !! b ?' })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('AND semantics across query tokens', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const both = await notes.create(ctx, 'person', pid, { title: 'Meeting', body: doc('alpha and bravo discussed') });
    const one = await notes.create(ctx, 'person', pid, { title: 'Other', body: doc('only alpha here') });
    expect(await ids(ctx, 'alpha bravo')).toEqual([both.id]);
    expect((await ids(ctx, 'alpha')).sort()).toEqual([both.id, one.id].sort());
    expect(await ids(ctx, 'alpha charlie')).toEqual([]);
  });

  it('matches word prefixes, case-insensitively, but not inside words', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const n = await notes.create(ctx, 'person', pid, { title: 'Plan', body: doc('The budgetary review') });
    expect(await ids(ctx, 'budg')).toEqual([n.id]);
    expect(await ids(ctx, 'BUDGETARY')).toEqual([n.id]);
    expect(await ids(ctx, 'udget')).toEqual([]);
    expect(await ids(ctx, 'budgetaryx')).toEqual([]);
  });

  it('a query token of 16 or more chars is matched on its first 15', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const n = await notes.create(ctx, 'person', pid, { title: 'Long', body: doc('internationalization matters') });
    expect(await ids(ctx, 'internationalization')).toEqual([n.id]);
    expect(await ids(ctx, 'internationalizing')).toEqual([n.id]);
  });

  it('does not fold accents', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const n = await notes.create(ctx, 'person', pid, { title: 'Pangram', body: doc('Zażółć gęślą jaźń') });
    expect(await ids(ctx, 'zażó')).toEqual([n.id]);
    expect(await ids(ctx, 'GĘŚLĄ')).toEqual([n.id]);
    expect(await ids(ctx, 'zazolc')).toEqual([]);
    expect(await ids(ctx, 'gesla')).toEqual([]);
  });

  it('drops a forced hash collision after decrypting and verifying', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const fake = await notes.create(ctx, 'person', pid, { title: 'Plain', body: doc('ordinary words only') });
    const real = await notes.create(ctx, 'person', pid, { title: 'Zoo', body: doc('a zebra was seen') });
    const { hashes } = queryTokens(ctx.userId, 'zebra');
    await q(
      `update hub_search_doc set tokens = tokens || $3::char(16)[] where user_id = $1 and item_id = $2`,
      [ctx.userId, fake.id, hashes],
    );
    expect(await ids(ctx, 'zebra')).toEqual([real.id]);
  });

  it('limits results with the types filter', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Kestrel Watcher');
    const company = (await records.create(ctx, 'company', { name: 'Kestrel Labs' })).record.id;
    const note = await notes.create(ctx, 'person', pid, { title: 'Birds', body: doc('a kestrel hovered') });
    expect((await ids(ctx, 'kestrel')).sort()).toEqual([pid, company, note.id].sort());
    expect(await ids(ctx, 'kestrel', { types: ['person'] })).toEqual([pid]);
    expect((await ids(ctx, 'kestrel', { types: ['company', 'note'] })).sort()).toEqual([company, note.id].sort());
    expect(await ids(ctx, 'kestrel', { types: ['file'] })).toEqual([]);
  });

  it('pages with an opaque cursor over at most 200 verified candidates, newest first', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const base = Date.now() - 1_000_000;
    const toks = indexTokens(ctx.userId, ['Entry', 'capword filler']);
    const seeded = await seedNotes(
      ctx.userId,
      pid,
      Array.from({ length: 205 }, (_, i) => ({ title: 'Entry', body: 'capword filler', updatedAt: new Date(base + i * 1000), tokens: toks })),
    );

    const first = await search(ctx, { q: 'capword' });
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toEqual(expect.any(String));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await search(ctx, { q: 'capword', limit: 100, cursor });
      seen.push(...res.items.map((i) => i.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
    // The 200 most recently changed, newest first; the 5 oldest are cut.
    expect(seen).toEqual([...seeded].reverse().slice(0, 200));
  });
});

describe('ranking', () => {
  it('title hit before body hit, more matched title terms first, then newest', async () => {
    const ctx = await newUser();
    const owner = await person(ctx, 'Anna Nowak');
    const a = await person(ctx, 'Orion Nebula');
    const b = (await records.create(ctx, 'project', { name: 'Orion', description: 'nebula survey' })).record.id;
    const c = await notes.create(ctx, 'person', owner, { title: 'Report', body: doc('orion nebula photos') });
    const d = await notes.create(ctx, 'person', owner, { title: 'Log', body: doc('nebula then orion') });
    expect(await ids(ctx, 'orion nebula')).toEqual([a, b, d.id, c.id]);
  });
});

describe('results and snippets', () => {
  it('returns type, title, owner with name, updatedAt and at most 2 snippets with highlight offsets, no HTML', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const body = `${filler(30)} needle ${filler(30)} Needles ${filler(30)} needle ${filler(5)}`;
    const note = await notes.create(ctx, 'person', pid, { title: 'Haystack', body: doc(body) });

    const res = await search(ctx, { q: 'needle' });
    expect(res.items).toHaveLength(1);
    const item = res.items[0]!;
    expect(item).toMatchObject({
      type: 'note',
      id: note.id,
      title: 'Haystack',
      owner: { kind: 'person', id: pid, name: 'Anna Nowak' },
      updatedAt: note.updatedAt,
    });
    expect(item.snippets.length).toBeGreaterThan(0);
    expect(item.snippets.length).toBeLessThanOrEqual(2);
    for (const s of item.snippets) {
      expect(s.highlights.length).toBeGreaterThan(0);
      for (const [start, end] of s.highlights) expect(s.text.slice(start, end).toLowerCase()).toBe('needle');
      expect(s.text.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/<\/?(mark|b|em|span)/);
  });

  it('a record without body text returns the matching field values; records have no owner', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Jan Kowalski', { roleTitle: 'Lighthouse keeper', emails: ['jan@harbor.test'] });
    const res = await search(ctx, { q: 'lighthouse' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ type: 'person', id: pid, title: 'Jan Kowalski', owner: null });
    expect(res.items[0]!.snippets[0]!.text).toContain('Lighthouse');
    const [[s, e]] = res.items[0]!.snippets[0]!.highlights as [[number, number]];
    expect(res.items[0]!.snippets[0]!.text.slice(s, e)).toBe('Lighthouse');

    const byMail = await search(ctx, { q: 'harbor' });
    expect(byMail.items.map((i) => i.id)).toEqual([pid]);
  });

  it('a file result carries its name as title and its owner record', async () => {
    const ctx = await newUser();
    const cid = (await records.create(ctx, 'company', { name: 'Acme' })).record.id;
    const up = await files.upload(ctx, 'company', cid, {
      bytes: Buffer.from('quarterly roadmap notes\n'),
      filename: 'plan.txt',
      description: 'roadmap overview',
    });
    const res = await search(ctx, { q: 'roadmap' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      type: 'file',
      id: up.file.id,
      title: 'plan.txt',
      owner: { kind: 'company', id: cid, name: 'Acme' },
    });
    expect(res.items[0]!.snippets[0]!.text).toContain('roadmap');
  });
});

describe('index writes', () => {
  it('create, edit and delete of a note update the index row', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const n = await notes.create(ctx, 'person', pid, { title: 'Draft', body: doc('pelican sighting') });
    expect(await ids(ctx, 'pelican')).toEqual([n.id]);

    await notes.patch(ctx, n.id, { body: doc('flamingo sighting') });
    expect(await ids(ctx, 'pelican')).toEqual([]);
    expect(await ids(ctx, 'flamingo')).toEqual([n.id]);

    await notes.patch(ctx, n.id, { title: 'Heron diary' });
    expect(await ids(ctx, 'draft')).toEqual([]);
    expect(await ids(ctx, 'heron')).toEqual([n.id]);

    await notes.remove(ctx, n.id);
    expect(await ids(ctx, 'flamingo')).toEqual([]);
    expect(await searchDocCount(ctx.userId, n.id)).toBe(0);
  });

  it('rename and delete of a record update its row; owner delete removes the rows of its notes and files', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Walrus Holdings');
    const n = await notes.create(ctx, 'person', pid, { title: 'Tusks', body: doc('ivory narwhal') });
    const f = await files.upload(ctx, 'person', pid, { bytes: Buffer.from('narwhal file\n'), filename: 'narwhal.txt' });

    await records.patch(ctx, 'person', pid, { name: 'Seal Holdings' });
    expect(await ids(ctx, 'walrus')).toEqual([]);
    expect(await ids(ctx, 'seal')).toEqual([pid]);
    expect((await ids(ctx, 'narwhal')).sort()).toEqual([n.id, f.file.id].sort());

    await records.remove(ctx, 'person', pid);
    expect(await ids(ctx, 'seal')).toEqual([]);
    expect(await ids(ctx, 'narwhal')).toEqual([]);
    for (const id of [pid, n.id, f.file.id]) expect(await searchDocCount(ctx.userId, id)).toBe(0);
  });

  it('file text arrival makes words of the extracted text findable', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const up = await files.upload(ctx, 'person', pid, { bytes: Buffer.from('placeholder\n'), filename: 'scan.txt' });
    expect(await ids(ctx, 'axolotl')).toEqual([]);

    // What the `hub.file-extract` worker does: store the filtered text and reindex in the same transaction.
    await withTransaction(async (tx) => {
      const updated = await content.updateFile(
        ctx,
        up.file.id,
        {
          extractionStatus: 'extracted',
          extractedTextEnc: encrypt('user-content', 'the axolotl regenerates limbs'),
          updatedAt: new Date(),
        },
        tx,
      );
      await files.reindexFile(ctx, updated!, tx);
    });
    expect(await ids(ctx, 'axolotl')).toEqual([up.file.id]);
    expect(await ids(ctx, 'scan')).toEqual([up.file.id]);
  });

  it('an excluded file is found by name only', async () => {
    const ctx = await newUser();
    const pid = await person(ctx, 'Anna Nowak');
    const up = await files.upload(ctx, 'person', pid, { bytes: Buffer.from('placeholder\n'), filename: 'quokka.txt' });
    await withTransaction(async (tx) => {
      const updated = await content.updateFile(
        ctx,
        up.file.id,
        { extractionStatus: 'excluded', extractedTextEnc: encrypt('user-content', 'secret dingo'), updatedAt: new Date() },
        tx,
      );
      await files.reindexFile(ctx, updated!, tx);
    });
    expect(await ids(ctx, 'quokka')).toEqual([up.file.id]);
    expect(await ids(ctx, 'dingo')).toEqual([]);
  });
});

describe('isolation (FR-001, FR-011)', () => {
  it("another user's items never appear", async () => {
    const a = await newUser();
    const b = await newUser();
    const pa = await person(a, 'Sentinel Alpha');
    await notes.create(a, 'person', pa, { title: 'Mine', body: doc('xylophone sentinel') });
    const pb = await person(b, 'Sentinel Beta');
    const nb = await notes.create(b, 'person', pb, { title: 'Theirs', body: doc('xylophone sentinel') });

    const fromA = await ids(a, 'sentinel');
    expect(fromA).toHaveLength(2);
    expect(fromA).not.toContain(pb);
    expect(fromA).not.toContain(nb.id);
    expect(await ids(b, 'alpha')).toEqual([]);

    // Same word, different hash per user: copying A's index row to B finds nothing for B either.
    const c = await newUser();
    await q(
      `insert into hub_search_doc (user_id, item_type, item_id, tokens, updated_at)
       select $2, item_type, item_id, tokens, updated_at from hub_search_doc where user_id = $1`,
      [a.userId, c.userId],
    );
    expect(await ids(c, 'sentinel')).toEqual([]);
    expect(await ids(c, 'xylophone')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// SC-003: 10,000 items including file text, p95 under 2 s

function recordTiming(entry: { name: string; sc: string; ms: number; limitMs: number }): void {
  mkdirSync(dirname(SC_TIMINGS_FILE), { recursive: true });
  const all: unknown[] = existsSync(SC_TIMINGS_FILE) ? (JSON.parse(readFileSync(SC_TIMINGS_FILE, 'utf8')) as unknown[]) : [];
  all.push({ ...entry, at: new Date().toISOString() });
  writeFileSync(SC_TIMINGS_FILE, `${JSON.stringify(all, null, 2)}\n`);
}

describe('performance (SC-003)', () => {
  it('a seeded 10,000-item hub answers in p95 under 2 s', { timeout: 300_000 }, async () => {
    const ctx = await newUser();
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const letters = 'abcdefghijklmnoprstuwyz';
    const vocab = Array.from({ length: 1500 }, () =>
      Array.from({ length: 4 + Math.floor(rnd() * 7) }, () => letters[Math.floor(rnd() * letters.length)]).join(''),
    );
    // Zipf-like pick: low indexes are common words.
    const pick = () => vocab[Math.floor(vocab.length * rnd() ** 3)]!;
    const words = (n: number) => Array.from({ length: n }, pick).join(' ');
    const wordTokens = new Map<string, string[]>();
    const tokensOf = (texts: string[]) => {
      const out = new Set<string>();
      for (const w of texts.join(' ').toLowerCase().split(/\s+/).filter(Boolean)) {
        let t = wordTokens.get(w);
        if (!t) wordTokens.set(w, (t = indexTokens(ctx.userId, [w])));
        for (const h of t) out.add(h);
      }
      return [...out];
    };

    const base = Date.now() - 20_000_000;
    const at = (i: number) => new Date(base + i * 1000);
    const peopleNames = Array.from({ length: 2000 }, () => `${pick()} ${pick()}`);
    const people = await seedPeople(ctx.userId, peopleNames, at, (n) => tokensOf([n]));
    const owner = people[0]!;
    await seedNotes(
      ctx.userId,
      owner,
      Array.from({ length: 4000 }, (_, i) => {
        const title = `${pick()} ${pick()}`;
        const body = words(80);
        return { title, body, updatedAt: at(2000 + i), tokens: tokensOf([title, body]) };
      }),
    );
    await seedFiles(
      ctx.userId,
      owner,
      Array.from({ length: 4000 }, (_, i) => {
        const name = `${pick()}.txt`;
        const text = words(400);
        return { name, text, updatedAt: at(6000 + i), tokens: tokensOf([name, text]) };
      }),
    );
    const [{ n }] = (await q<{ n: number }>('select count(*)::int as n from hub_search_doc where user_id = $1', [
      ctx.userId,
    ])) as [{ n: number }];
    expect(n).toBe(10_000);

    const queries = [
      vocab[0]!,
      vocab[1]!,
      vocab[2]!,
      `${vocab[0]} ${vocab[1]}`,
      `${vocab[3]} ${vocab[5]}`,
      vocab[0]!.slice(0, 2),
      vocab[10]!.slice(0, 3),
      vocab[50]!,
      vocab[200]!,
      vocab[1499]!,
      `${vocab[4]} ${vocab[900]}`,
      'zzzznotthere',
      vocab[7]!,
      vocab[1]!.slice(0, 2),
      `${vocab[2]} ${vocab[6]} ${vocab[8]}`,
      vocab[100]!,
      vocab[30]!.slice(0, 4),
      vocab[12]!,
      vocab[600]!,
      vocab[0]!.slice(0, 3),
    ];
    await search(ctx, { q: vocab[0]! }); // warm-up
    const times: number[] = [];
    for (const query of queries) {
      const started = performance.now();
      await search(ctx, { q: query, limit: 20 });
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    const p95 = Math.round(times[Math.ceil(times.length * 0.95) - 1]!);
    recordTiming({ name: 'hub search p95 at 10,000 items', sc: 'SC-003', ms: p95, limitMs: 2000 });
    expect(p95).toBeLessThan(2000);
  });
});

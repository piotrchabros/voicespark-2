import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, FILTER_CATEGORIES, getDb, getPool, user } from '@voicespark/db';
import { decrypt, encrypt } from '@voicespark/core/crypto';
import { resetEnvForTests } from '@voicespark/core/env';
import type { ServiceContext } from '@voicespark/core/errors';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import { enqueue, JOB_OPTIONS, jobIds, type JobPayload } from '@voicespark/core/queues';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import * as notes from '@voicespark/core/services/hub/notes';
import * as records from '@voicespark/core/services/hub/records';
import { LOCKED_CATEGORIES, type Classifier, type FilteredText } from '@voicespark/filters';
import { InMemoryMemoryStore, namespaceFor } from '@voicespark/integrations/supermemory';
import { createHubRefilterHandler, REFILTER_NOTE_PLACEHOLDER } from '../src/processors/hub-refilter';
import { hubRefilterRetry } from '../src/processors/maintenance';

// US7 hub.refilter (T078, contracts/jobs.md (15) and (16); data-model.md "Filter-preference change"; FR-028,
// constitution VI). Postgres and the in-memory store; queues are mocked and the handler is called directly. The data
// is written under a locked-only policy through the services, then the user selects every category, so a payment card
// number becomes a redaction and a text the scripted classifier calls mostly `health` becomes a whole-item exclusion.
type RefilterPayload = JobPayload<'hub.refilter'>;

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';
process.env.HUB_FILES_DIR = mkdtempSync(join(tmpdir(), 'vs-hub-refilter-'));
resetEnvForTests();

const CARD = '4111 1111 1111 1111';
const CARD_TOKEN = '4111';
// The scripted classifier calls a text with this marker mostly `health` once `health` is selected.
const HEALTH = 'cardiologyreferral';

/** Answers like the real classifier for the categories it is asked about; `fail` throws (inspection failure). */
function scriptedClassifier(opts: { fail?: boolean } = {}): Classifier {
  return {
    async classify(text, o) {
      if (opts.fail) throw new Error('classifier unavailable');
      if ((o?.categories ?? []).includes('health') && text.includes(HEALTH)) {
        return { spans: [{ category: 'health', text: HEALTH }], mostlySensitive: true };
      }
      return { spans: [], mostlySensitive: false };
    },
  };
}

const store = new InMemoryMemoryStore();
let handler: ReturnType<typeof createHubRefilterHandler>;
let failing: ReturnType<typeof createHubRefilterHandler>;

const userIds: string[] = [];

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function createUser(): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Hub Refilter', email: `hub-refilter-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  const ctx: ServiceContext = { userId: row!.id, role: 'user' };
  // Version 1: locked categories only, so cards and health text are stored as written.
  await filterPrefs.update(ctx, [...LOCKED_CATEGORIES]);
  return ctx;
}

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...texts: string[]) => ({ type: 'doc', content: texts.map(paragraph) });

interface Seeded {
  ctx: ServiceContext;
  personId: string;
  cardNoteId: string;
  healthNoteId: string;
  cardFileId: string;
  healthFileId: string;
  threadId: string;
}

async function insertFile(ctx: ServiceContext, personId: string, text: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into hub_file (user_id, person_id, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id,
       extraction_status, extracted_text_enc)
     values ($1, $2, $3, 'text/plain', 'txt', 10, $4, $5, 'k1', 'extracted', $6) returning id`,
    [
      ctx.userId,
      personId,
      encrypt('user-content', 'Plan.txt'),
      createHash('sha256').update(randomUUID()).digest('hex'),
      randomUUID(),
      encrypt('user-content', text),
    ],
  );
  return row!.id;
}

/** A person with a card in the description, two notes, two extracted files and an attached summary. */
async function seed(): Promise<Seeded> {
  const ctx = await createUser();
  const { record } = await records.create(ctx, 'person', {
    name: 'Anna Nowak',
    roleTitle: 'Buyer',
    description: `Pays with ${CARD} every month`,
  });
  const cardNote = await notes.create(ctx, 'person', record.id, {
    title: 'Billing',
    body: doc(`Charge ${CARD} for the orchard plan`, 'Thanks for the call'),
  });
  const healthNote = await notes.create(ctx, 'person', record.id, {
    title: 'Visit',
    body: doc(`Notes on the ${HEALTH} and the follow-up`),
  });
  const cardFileId = await insertFile(ctx, record.id, `Invoice settled with card ${CARD} in March.`);
  const healthFileId = await insertFile(ctx, record.id, `Scanned ${HEALTH} letter for the clinic.`);
  const [thread] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, summary_enc, status) values ($1, $2, $3, 'done') returning id`,
    [ctx.userId, createHash('sha256').update(randomUUID()).digest('hex'), encrypt('user-content', `Agreed to bill ${CARD}.`)],
  );
  await q('insert into hub_thread_record (user_id, thread_id, person_id) values ($1, $2, $3)', [
    ctx.userId,
    thread!.id,
    record.id,
  ]);
  // Every item starts out stored in the memory store (old policy content).
  await q(
    `insert into hub_sync_item (user_id, entity_type, entity_id, doc_id, status, synced_version, last_synced_at)
     values ($1, 'file', $2::uuid, 'hub_file_' || $2::text, 'stored', 1, now()),
            ($1, 'file', $3::uuid, 'hub_file_' || $3::text, 'stored', 1, now()),
            ($1, 'summary', $4::uuid, 'hub_summary_' || $4::text, 'stored', 1, now())`,
    [ctx.userId, cardFileId, healthFileId, thread!.id],
  );
  await q(`update hub_sync_item set status = 'stored', synced_version = version, last_synced_at = now() where user_id = $1`, [
    ctx.userId,
  ]);
  const ids = (await q<{ doc_id: string }>('select doc_id from hub_sync_item where user_id = $1', [ctx.userId])).map(
    (r) => r.doc_id,
  );
  await store.addDocuments(
    namespaceFor(ctx.userId),
    ids.map((id) => ({
      id,
      content: `old ${CARD}` as FilteredText,
      documentDate: new Date().toISOString(),
      metadata: {},
    })),
  );
  return {
    ctx,
    personId: record.id,
    cardNoteId: cardNote.id,
    healthNoteId: healthNote.id,
    cardFileId,
    healthFileId,
    threadId: thread!.id,
  };
}

/** Selects every category: version 2. */
async function selectAll(s: Seeded): Promise<number> {
  const { preferences } = await filterPrefs.update(s.ctx, [...FILTER_CATEGORIES]);
  return preferences.version;
}

const textOf = (enc: string | null) => (enc === null ? null : decrypt('user-content', enc));

async function noteRow(id: string) {
  const [r] = await q<{ title_enc: string; body_json_enc: string; redacted_values: number }>(
    'select title_enc, body_json_enc, redacted_values from hub_note where id = $1',
    [id],
  );
  return r ? { title: textOf(r.title_enc)!, body: JSON.parse(textOf(r.body_json_enc)!), redacted: r.redacted_values } : null;
}

async function fileRow(id: string) {
  const [r] = await q<{
    extraction_status: string;
    extraction_reason: string | null;
    extracted_text_enc: string | null;
    redacted_values: number;
  }>('select extraction_status, extraction_reason, extracted_text_enc, redacted_values from hub_file where id = $1', [id]);
  return r ? { ...r, text: textOf(r.extracted_text_enc) } : null;
}

async function personDescription(id: string): Promise<string | null> {
  const [r] = await q<{ description_enc: string | null }>('select description_enc from hub_person where id = $1', [id]);
  return textOf(r!.description_enc);
}

async function summaryText(threadId: string): Promise<string | null> {
  const [r] = await q<{ summary_enc: string | null }>('select summary_enc from hub_thread where id = $1', [threadId]);
  return textOf(r!.summary_enc);
}

async function searchTokens(userId: string, itemType: string, itemId: string): Promise<string[]> {
  const [r] = await q<{ tokens: string[] }>(
    'select tokens from hub_search_doc where user_id = $1 and item_type = $2 and item_id = $3',
    [userId, itemType, itemId],
  );
  return (r?.tokens ?? []).map((t) => t.trim());
}

type SyncRow = {
  doc_id: string;
  version: number;
  status: string;
  last_error_code: string | null;
  due: boolean;
};

async function syncRows(userId: string): Promise<Map<string, SyncRow>> {
  const rows = await q<SyncRow>(
    `select doc_id, version::int as version, status, last_error_code,
            (next_attempt_at is null or next_attempt_at <= now() + interval '1 hour') as due
       from hub_sync_item where user_id = $1`,
    [userId],
  );
  return new Map(rows.map((r) => [r.doc_id, r]));
}

function fakeJob(payload: RefilterPayload, attemptsMade = 0) {
  return {
    id: jobIds.hubRefilter(payload.userId, payload.policyVersion),
    name: 'hub.refilter',
    data: payload,
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job<RefilterPayload, unknown, 'hub.refilter'>;
}

type RefilterResult = { outcome: string; pending?: number };

async function run(s: Seeded, policyVersion: number, attemptsMade = 0, h = handler): Promise<RefilterResult> {
  return (await h(fakeJob({ userId: s.ctx.userId, policyVersion }, attemptsMade), 'token')) as RefilterResult;
}

const refilterCalls = () => vi.mocked(enqueue).mock.calls.filter(([name]) => name === 'hub.refilter');

beforeAll(async () => {
  await getPool().query('select 1');
  handler = createHubRefilterHandler({ store, classifier: scriptedClassifier() });
  failing = createHubRefilterHandler({ store, classifier: scriptedClassifier({ fail: true }) });
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getPool().query('delete from deletion_request where user_id = any($1::uuid[])', [userIds]);
    await getDb().delete(user).where(inArray(user.id, userIds));
  }
  await closeDb();
});

describe('hub.refilter: enqueue', () => {
  it('is enqueued with the new version when filter_preferences.version grows and the user has hub data', async () => {
    const s = await seed();
    vi.mocked(enqueue).mockClear();
    const version = await selectAll(s);

    expect(version).toBe(2);
    expect(refilterCalls()).toEqual([
      ['hub.refilter', { userId: s.ctx.userId, policyVersion: 2 }, { jobId: jobIds.hubRefilter(s.ctx.userId, 2) }],
    ]);
  });

  it('holds every sync item as refilter_pending in the save, survives a lost enqueue, and the daily retry enqueues it', async () => {
    const s = await seed();
    const before = await syncRows(s.ctx.userId);
    expect(before.size).toBeGreaterThan(0);
    vi.mocked(enqueue).mockClear();
    vi.mocked(enqueue).mockImplementation(async (name) => {
      if (name === 'hub.refilter') throw new Error('redis down');
      return {} as never;
    });
    try {
      const { preferences } = await filterPrefs.update(s.ctx, [...FILTER_CATEGORIES]);
      expect(preferences.version).toBe(2);
      expect(preferences.selectedCategories).toEqual([...FILTER_CATEGORIES]);
    } finally {
      vi.mocked(enqueue).mockImplementation(async () => ({}) as never);
    }
    expect(refilterCalls()).toHaveLength(1);
    expect((await filterPrefs.get(s.ctx)).version).toBe(2);

    const after = await syncRows(s.ctx.userId);
    for (const [docId, row] of after) {
      expect(row).toMatchObject({ status: 'pending', last_error_code: 'refilter_pending' });
      expect(row.version).toBe(before.get(docId)!.version + 1);
    }

    vi.mocked(enqueue).mockClear();
    await hubRefilterRetry();
    expect(refilterCalls()).toContainEqual([
      'hub.refilter',
      { userId: s.ctx.userId, policyVersion: 2 },
      { jobId: jobIds.hubRefilter(s.ctx.userId, 2) },
    ]);

    // The refilter releases every row it re-inspected.
    expect((await run(s, 2)).outcome).toBe('refiltered');
    for (const row of (await syncRows(s.ctx.userId)).values()) {
      expect(row).toMatchObject({ status: 'pending', last_error_code: null, due: true });
    }
  });

  it('is not enqueued for a user without hub data', async () => {
    const ctx = await createUser();
    vi.mocked(enqueue).mockClear();
    await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);
    expect(refilterCalls()).toEqual([]);
  });
});

describe('hub.refilter: re-inspection under the new policy', () => {
  it('redacts summaries, note bodies, file text and record fields, re-encrypts, re-indexes and marks every item dirty', async () => {
    const s = await seed();
    const noteBefore = await noteRow(s.cardNoteId);
    const fileBefore = await fileRow(s.cardFileId);
    expect(await searchTokens(s.ctx.userId, 'note', s.cardNoteId)).toEqual(
      expect.arrayContaining(indexTokens(s.ctx.userId, [CARD_TOKEN])),
    );
    const before = await syncRows(s.ctx.userId);
    const version = await selectAll(s);

    expect((await run(s, version)).outcome).toBe('refiltered');

    expect(await personDescription(s.personId)).not.toContain(CARD);
    expect(await summaryText(s.threadId)).not.toContain(CARD);
    const note = await noteRow(s.cardNoteId);
    expect(JSON.stringify(note!.body)).not.toContain(CARD);
    expect(JSON.stringify(note!.body)).toContain('Thanks for the call');
    expect(note!.redacted).toBeGreaterThan(noteBefore!.redacted);
    const file = await fileRow(s.cardFileId);
    expect(file).toMatchObject({ extraction_status: 'extracted' });
    expect(file!.text).not.toContain(CARD);
    expect(file!.text).toContain('Invoice settled');
    expect(file!.redacted_values).toBeGreaterThan(fileBefore!.redacted_values);

    const cardTokens = indexTokens(s.ctx.userId, [CARD_TOKEN]);
    for (const [type, id] of [
      ['note', s.cardNoteId],
      ['file', s.cardFileId],
      ['person', s.personId],
    ] as const) {
      expect(await searchTokens(s.ctx.userId, type, id)).not.toEqual(expect.arrayContaining(cardTokens));
    }

    const after = await syncRows(s.ctx.userId);
    expect(after.size).toBe(before.size);
    for (const [docId, row] of after) {
      expect(row.version).toBeGreaterThan(before.get(docId)!.version);
      expect(row).toMatchObject({ status: 'pending', last_error_code: null, due: true });
    }
    // The memory documents are rebuilt by hub.sync, not by the refilter itself.
    expect(await store.getDocument(namespaceFor(s.ctx.userId), `hub_note_${s.cardNoteId}`)).not.toBeNull();
  });

  it('keeps a wholly excluded note with a placeholder paragraph and an updated redacted_values', async () => {
    const s = await seed();
    const before = await noteRow(s.healthNoteId);
    await run(s, await selectAll(s));

    const note = await noteRow(s.healthNoteId);
    expect(note).not.toBeNull();
    expect(note!.body).toEqual({ type: 'doc', content: [paragraph(REFILTER_NOTE_PLACEHOLDER)] });
    expect(JSON.stringify(note)).not.toContain(HEALTH);
    expect(note!.redacted).toBeGreaterThan(before!.redacted);
    expect(await searchTokens(s.ctx.userId, 'note', s.healthNoteId)).not.toEqual(
      expect.arrayContaining(indexTokens(s.ctx.userId, [HEALTH])),
    );
  });

  it('a wholly excluded file becomes excluded with its text cleared', async () => {
    const s = await seed();
    await run(s, await selectAll(s));

    expect(await fileRow(s.healthFileId)).toMatchObject({
      extraction_status: 'excluded',
      extraction_reason: 'health',
      extracted_text_enc: null,
    });
    expect(await searchTokens(s.ctx.userId, 'file', s.healthFileId)).not.toEqual(
      expect.arrayContaining(indexTokens(s.ctx.userId, [HEALTH])),
    );
  });

  it('is idempotent per policy version and skips a stale version', async () => {
    const s = await seed();
    const version = await selectAll(s);
    await run(s, version);
    const note = await noteRow(s.cardNoteId);
    const excluded = await noteRow(s.healthNoteId);
    const file = await fileRow(s.cardFileId);
    const description = await personDescription(s.personId);

    expect((await run(s, version)).outcome).toBe('refiltered');
    expect(await noteRow(s.cardNoteId)).toEqual(note);
    expect(await noteRow(s.healthNoteId)).toEqual(excluded);
    expect((await fileRow(s.cardFileId))!.text).toBe(file!.text);
    expect((await fileRow(s.cardFileId))!.redacted_values).toBe(file!.redacted_values);
    expect(await personDescription(s.personId)).toBe(description);

    const sync = await syncRows(s.ctx.userId);
    expect((await run(s, version - 1)).outcome).toBe('skipped');
    expect(await syncRows(s.ctx.userId)).toEqual(sync);
  });

  it('finishes quietly for a user who is not active', async () => {
    const s = await seed();
    const version = await selectAll(s);
    await q(`update "user" set status = 'suspended' where id = $1`, [s.ctx.userId]);
    expect((await run(s, version)).outcome).toBe('skipped');
    expect(await personDescription(s.personId)).toContain(CARD);
  });
});

describe('hub.refilter: final failure (fail-closed)', () => {
  it('deletes the memory documents, holds the items as refilter_pending, notifies, and the daily retry refilters them', async () => {
    const s = await seed();
    const version = await selectAll(s);
    const ns = namespaceFor(s.ctx.userId);
    const docIds = [...(await syncRows(s.ctx.userId)).keys()];
    const tokensBefore = await searchTokens(s.ctx.userId, 'note', s.cardNoteId);

    // Attempts 1 and 2 throw (BullMQ retries); nothing is deleted yet.
    await expect(run(s, version, 0, failing)).rejects.toThrow();
    await expect(run(s, version, 1, failing)).rejects.toThrow();
    for (const id of docIds) expect(await store.getDocument(ns, id)).not.toBeNull();

    // The last attempt: documents deleted, rows held, user notified.
    const result = await run(s, version, 2, failing);
    expect(result.outcome).toBe('refilter_pending');
    expect(result.pending).toBe(docIds.length);
    for (const id of docIds) expect(await store.getDocument(ns, id)).toBeNull();
    const held = await syncRows(s.ctx.userId);
    for (const row of held.values()) {
      expect(row).toMatchObject({ status: 'pending', last_error_code: 'refilter_pending', due: false });
    }

    // The items stay in the app, unchanged, and their search rows are not rewritten.
    expect(JSON.stringify((await noteRow(s.cardNoteId))!.body)).toContain(CARD);
    expect((await fileRow(s.cardFileId))!.text).toContain(CARD);
    expect(await personDescription(s.personId)).toContain(CARD);
    expect(await searchTokens(s.ctx.userId, 'note', s.cardNoteId)).toEqual(tokensBefore);

    const notified = await q<{ type: string; payload: Record<string, unknown> }>(
      'select type, payload from notification where user_id = $1',
      [s.ctx.userId],
    );
    expect(notified).toEqual([{ type: 'hub_refilter_pending', payload: { items: docIds.length } }]);
    expect(JSON.stringify(notified)).not.toContain(CARD);

    // Daily retry: re-enqueues hub.refilter for this user under the current version (same job id; see the re-enqueue
    // test below) and no one else.
    vi.mocked(enqueue).mockClear();
    const retry = await hubRefilterRetry();
    expect(retry.count).toBeGreaterThanOrEqual(1);
    const calls = refilterCalls().filter(([, payload]) => (payload as RefilterPayload).userId === s.ctx.userId);
    expect(calls).toEqual([
      ['hub.refilter', { userId: s.ctx.userId, policyVersion: version }, { jobId: jobIds.hubRefilter(s.ctx.userId, version) }],
    ]);

    // Once the inspection works, the retry refilters and releases the items to hub.sync.
    expect((await run(s, version, 0, handler)).outcome).toBe('refiltered');
    expect(JSON.stringify((await noteRow(s.cardNoteId))!.body)).not.toContain(CARD);
    expect(await personDescription(s.personId)).not.toContain(CARD);
    for (const row of (await syncRows(s.ctx.userId)).values()) {
      expect(row).toMatchObject({ status: 'pending', last_error_code: null, due: true });
    }
    vi.mocked(enqueue).mockClear();
    await hubRefilterRetry();
    expect(refilterCalls().filter(([, p]) => (p as RefilterPayload).userId === s.ctx.userId)).toHaveLength(0);
  });
});

describe('hub.refilter: re-enqueue of the same policy version', () => {
  // Real BullMQ on a throwaway prefix: a finished job must not swallow a later add with the same id (daily retry,
  // credential-audit hit), while a job that is still waiting does.
  it('a completed or failed job does not dedupe the next add; a waiting one does', async () => {
    const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const prefix = `vs-test-refilter-${randomUUID()}`;
    const queue = new Queue('hub', { connection, prefix });
    const payload = { userId: randomUUID(), policyVersion: 3 };
    const id = jobIds.hubRefilter(payload.userId, 3);
    const opts = { ...JOB_OPTIONS['hub.refilter'], jobId: id, attempts: 1 };
    let fail = false;
    const worker = new Worker(
      'hub',
      async () => {
        if (fail) throw new Error('inspection_failed');
      },
      { connection, prefix, autorun: false },
    );
    const settle = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          worker.off('completed', done);
          worker.off('failed', done);
          resolve();
        };
        worker.on('completed', done);
        worker.on('failed', done);
      });
    const queued = async () => {
      const c = await queue.getJobCounts('waiting', 'paused', 'prioritized');
      return (c.waiting ?? 0) + (c.paused ?? 0) + (c.prioritized ?? 0);
    };
    try {
      expect(JOB_OPTIONS['hub.refilter']).toMatchObject({ removeOnComplete: true, removeOnFail: true, attempts: 3 });

      // Waiting: a second add with the same id is a no-op.
      await queue.add('hub.refilter', payload, opts);
      await queue.add('hub.refilter', payload, opts);
      expect(await queued()).toBe(1);

      // Completed, then added again: a new job is queued.
      const completed = settle();
      void worker.run();
      await completed;
      await worker.pause();
      expect(await queue.getJob(id)).toBeUndefined();
      fail = true;
      await queue.add('hub.refilter', payload, opts);
      expect(await queued()).toBe(1);

      // Failed, then added again: a new job is queued.
      const failed = settle();
      worker.resume();
      await failed;
      await worker.pause();
      expect(await queue.getJob(id)).toBeUndefined();
      await queue.add('hub.refilter', payload, opts);
      expect(await queued()).toBe(1);
    } finally {
      await worker.close(true);
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  }, 30_000);
});

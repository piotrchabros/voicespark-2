import { createHash, randomUUID } from 'node:crypto';
import { DelayedError, Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, FILTER_CATEGORIES, getDb, getPool, user, withTransaction } from '@voicespark/db';
import { encrypt } from '@voicespark/core/crypto';
import { resetEnvForTests } from '@voicespark/core/env';
import type { ServiceContext } from '@voicespark/core/errors';
import { enqueue, JOB_OPTIONS, jobIds, type JobPayload } from '@voicespark/core/queues';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import { buildDocumentFor } from '@voicespark/core/services/hub/doc-builder';
import * as links from '@voicespark/core/services/hub/links';
import * as notes from '@voicespark/core/services/hub/notes';
import * as records from '@voicespark/core/services/hub/records';
import { markDirty, tombstone } from '@voicespark/core/services/hub/sync';
import type { Classifier } from '@voicespark/filters';
import {
  InMemoryMemoryStore,
  MemoryStoreBusyError,
  namespaceFor,
  SupermemoryV3Adapter,
  type MemoryDoc,
  type MemoryStore,
} from '@voicespark/integrations/supermemory';
import { createFakeSupermemoryV3 } from '../../../packages/integrations/test/helpers/fake-supermemory-v3';
import { hubSyncSweep } from '../src/processors/maintenance';
import { createHubSyncHandler } from '../src/processors/hub-sync';

// US7 hub.sync (T076, contracts/jobs.md (13), contracts/memory-store-hub.md; FR-025, FR-026, FR-028, SC-010). Postgres,
// the in-memory store and the fake v3 server (never the production store). Queues are mocked except for the wake-up
// id check, which runs against the test Redis under its own prefix; the handler is called directly.
type SyncPayload = JobPayload<'hub.sync'>;

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
resetEnvForTests();

const EMAIL = 'anna.nowak@acme-orchard.test';
const PHONE = '+48 601 234 567';
const DOMAIN = 'acme-orchard.test';
const SC010_MS = 60_000;

const HUB_KEYS_ALL = [
  'vs_kind',
  'vs_hub_item_id',
  'vs_hub_linked_keys',
  'vs_item_ts',
  'vs_hub_version',
  'vs_filter_policy_version',
];
const FORBIDDEN_KEYS = [
  'vs_authorship',
  'vs_source_ids',
  'vs_content_item_id',
  'vs_parent_item_id',
  'vs_sender_hash',
  'vs_folders',
];

/** Classifier that answers "nothing sensitive". */
const classifier: Classifier = {
  async classify() {
    return { spans: [], mostlySensitive: false };
  },
};

const store = new InMemoryMemoryStore();
let handler: ReturnType<typeof createHubSyncHandler>;
const userIds: string[] = [];

async function createUser(categories: readonly string[] = FILTER_CATEGORIES): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Hub Syncer', email: `hub-sync-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  const ctx: ServiceContext = { userId: row!.id, role: 'user' };
  await filterPrefs.update(ctx, [...categories]);
  return ctx;
}

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

interface SyncRow {
  status: string;
  version: number;
  synced_version: number;
  attempts: number;
  deleted: boolean;
  last_error_code: string | null;
  next_attempt_at: Date | null;
  lease_until: Date | null;
}

async function syncRow(userId: string, docId: string): Promise<SyncRow | undefined> {
  const [r] = await q<SyncRow & Record<string, unknown>>(
    `select status, version::int as version, synced_version::int as synced_version, attempts, deleted, last_error_code,
       next_attempt_at, lease_until from hub_sync_item where user_id = $1 and doc_id = $2`,
    [userId, docId],
  );
  return r;
}

/** Skips the 2 s debounce: every unsettled row of the user is due now. */
async function makeDue(userId: string): Promise<void> {
  await q(
    `update hub_sync_item set next_attempt_at = now() where user_id = $1 and (status <> 'stored' or synced_version < version)`,
    [userId],
  );
}

function fakeJob(payload: SyncPayload) {
  return {
    id: jobIds.hubSync(payload.userId),
    name: 'hub.sync',
    data: payload,
    attemptsMade: 0,
    opts: { attempts: 1 },
    moveToDelayed: vi.fn(async () => undefined),
  } as unknown as Job<SyncPayload, unknown, 'hub.sync'> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

/** Runs the handler once; a self re-enqueue (DelayedError) counts as a normal end of the run. */
async function runSync(ctx: ServiceContext, h = handler) {
  const job = fakeJob({ userId: ctx.userId });
  let requeued = false;
  try {
    await h(job, 'token');
  } catch (err) {
    if (!(err instanceof DelayedError)) throw err;
    requeued = true;
  }
  return { job, requeued };
}

/** makeDue + run until nothing is left for the user. */
async function syncAll(ctx: ServiceContext, h = handler): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await makeDue(ctx.userId);
    const { requeued } = await runSync(ctx, h);
    if (!requeued) return;
  }
}

const ns = (ctx: ServiceContext) => namespaceFor(ctx.userId);
const doc = (ctx: ServiceContext, id: string, s: MemoryStore = store) => s.getDocument(ns(ctx), id);

const noteBody = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function seedFile(ctx: ServiceContext, personId: string, text: string): Promise<string> {
  const bytes = Buffer.from(text);
  const [row] = await q<{ id: string }>(
    `insert into hub_file (user_id, person_id, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id,
       extraction_status, extracted_text_enc)
     values ($1, $2, $3, 'text/plain', 'txt', $4, $5, $6, 'k1', 'extracted', $7) returning id`,
    [
      ctx.userId,
      personId,
      encrypt('user-content', 'Orchard plan.txt'),
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      randomUUID(),
      encrypt('user-content', text),
    ],
  );
  await withTransaction((tx) => markDirty(tx, ctx.userId, 'file', row!.id));
  return row!.id;
}

async function seedSummary(ctx: ServiceContext, personId: string): Promise<string> {
  const participants = [
    { address: EMAIL, name: 'Anna Nowak', roles: ['from'], sent: true, owner: false, automated: false, roleAddress: false, freeMail: false },
    { address: 'me@example.test', name: null, roles: ['to'], sent: false, owner: true, automated: false, roleAddress: false, freeMail: false },
  ];
  const [row] = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, subject_enc, participants_enc, first_message_at, last_message_at,
       message_count, language, summary_enc, summary_version, summary_updated_at, status, processed_version)
     values ($1, $2, $3, $4, '2026-10-01T09:00:00Z', '2026-10-03T09:00:00Z', 3, 'en', $5, 1, now(), 'done', 1)
     returning id`,
    [
      ctx.userId,
      createHash('sha256').update(randomUUID()).digest('hex'),
      encrypt('user-content', 'Harvest contract'),
      encrypt('user-content', JSON.stringify(participants)),
      encrypt('user-content', 'Anna agreed to deliver the apples in October.'),
    ],
  );
  await q('insert into hub_thread_record (user_id, thread_id, person_id) values ($1, $2, $3)', [
    ctx.userId,
    row!.id,
    personId,
  ]);
  await withTransaction((tx) => markDirty(tx, ctx.userId, 'summary', row!.id));
  return row!.id;
}

function metadataKeys(meta: Record<string, unknown>): string[] {
  return Object.keys(meta).sort();
}

beforeAll(async () => {
  await getPool().query('select 1');
  handler = createHubSyncHandler({ store, classifier });
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

describe('hub.sync: stored (SC-010, FR-025)', () => {
  it('stores a new record and note within 1 minute with the hub ids and metadata', async () => {
    const ctx = await createUser();
    const started = Date.now();
    const { record } = await records.create(ctx, 'person', {
      name: 'Anna Nowak',
      roleTitle: 'CTO',
      phone: PHONE,
      description: 'Runs the orchard cooperative.',
      emails: [EMAIL],
    });
    const note = await notes.create(ctx, 'person', record.id, { title: 'Kickoff', body: noteBody('Discussed the harvest plan.') });

    await makeDue(ctx.userId);
    await runSync(ctx);

    const personDoc = `hub_person_${record.id}`;
    const noteDoc = `hub_note_${note.id}`;
    for (const id of [personDoc, noteDoc]) {
      const row = await syncRow(ctx.userId, id);
      expect(row).toMatchObject({ status: 'stored', attempts: 0, last_error_code: null });
      expect(row!.synced_version).toBe(row!.version);
    }
    expect(Date.now() - started).toBeLessThan(SC010_MS);

    const p = await doc(ctx, personDoc);
    const n = await doc(ctx, noteDoc);
    expect(p).not.toBeNull();
    expect(n).not.toBeNull();

    expect(metadataKeys(p!.metadata)).toEqual([...HUB_KEYS_ALL, 'vs_hub_email_hashes'].sort());
    expect(p!.metadata).toMatchObject({
      vs_kind: 'hub_person',
      vs_hub_item_id: record.id,
      vs_hub_linked_keys: [],
      vs_hub_version: (await syncRow(ctx.userId, personDoc))!.version,
    });
    expect(p!.metadata.vs_hub_email_hashes).toHaveLength(1);
    expect(typeof p!.metadata.vs_item_ts).toBe('number');
    expect(typeof p!.metadata.vs_filter_policy_version).toBe('number');

    expect(metadataKeys(n!.metadata)).toEqual([...HUB_KEYS_ALL, 'vs_hub_owner_kind', 'vs_hub_owner_id'].sort());
    expect(n!.metadata).toMatchObject({
      vs_kind: 'hub_note',
      vs_hub_item_id: note.id,
      vs_hub_owner_kind: 'person',
      vs_hub_owner_id: record.id,
      vs_hub_linked_keys: [`person:${record.id}`],
    });

    for (const d of [p!, n!]) {
      for (const k of FORBIDDEN_KEYS) expect(d.metadata).not.toHaveProperty(k);
      const meta = JSON.stringify(d.metadata);
      for (const raw of ['Anna', 'Nowak', EMAIL, DOMAIN, '601 234 567', 'Kickoff']) expect(meta).not.toContain(raw);
    }

    // Content is the document built from the current rows.
    const builtPerson = await buildDocumentFor(ctx.userId, 'person', record.id, { classifier });
    const builtNote = await buildDocumentFor(ctx.userId, 'note', note.id, { classifier });
    expect(p!.content).toBe(builtPerson!.content);
    expect(n!.content).toBe(builtNote!.content);
    expect(p!.content).toContain('# Person: Anna Nowak');
    expect(p!.content).toContain('Role: CTO');
    expect(p!.content).toContain('Runs the orchard cooperative.');
    expect(n!.content).toContain('# Note: Kickoff');
    expect(n!.content).toContain('Belongs to: person Anna Nowak');
    expect(n!.content).toContain('Discussed the harvest plan.');
  });

  it('company metadata carries domain hashes and never the domain', async () => {
    const ctx = await createUser();
    const { record } = await records.create(ctx, 'company', { name: 'Acme Orchard', domains: [DOMAIN] });
    await syncAll(ctx);

    const c = await doc(ctx, `hub_company_${record.id}`);
    expect(metadataKeys(c!.metadata)).toEqual([...HUB_KEYS_ALL, 'vs_hub_domain_hashes'].sort());
    expect(c!.metadata.vs_hub_domain_hashes).toHaveLength(1);
    expect(JSON.stringify(c!.metadata)).not.toContain(DOMAIN);
    expect(JSON.stringify(c!.metadata)).not.toContain('Acme');
    // Domains are written under every policy.
    expect(c!.content).toContain(`Domains: ${DOMAIN}`);
  });

  it('a summary document carries vs_lang', async () => {
    const ctx = await createUser();
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak' });
    const threadId = await seedSummary(ctx, record.id);
    await syncAll(ctx);

    const s = await doc(ctx, `hub_summary_${threadId}`);
    expect(metadataKeys(s!.metadata)).toEqual([...HUB_KEYS_ALL, 'vs_lang'].sort());
    expect(s!.metadata).toMatchObject({ vs_kind: 'hub_summary', vs_lang: 'en', vs_hub_linked_keys: [`person:${record.id}`] });
    expect(s!.content).toContain('# Conversation: Harvest contract');
    expect(s!.content).toContain('Anna agreed to deliver the apples in October.');
    expect(s!.content).toContain('me');
    expect(JSON.stringify(s!.metadata)).not.toContain('Harvest');
  });
});

describe('hub.sync: contact values (FR-028)', () => {
  it('leaves email and phone lines out when third_party_contacts is selected', async () => {
    const ctx = await createUser(FILTER_CATEGORIES);
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak', phone: PHONE, emails: [EMAIL] });
    const threadId = await seedSummary(ctx, record.id);
    await syncAll(ctx);

    const p = await doc(ctx, `hub_person_${record.id}`);
    expect(p!.content).toContain('# Person: Anna Nowak');
    expect(p!.content).not.toContain('Email:');
    expect(p!.content).not.toContain('Phone:');
    expect(p!.content).not.toContain(EMAIL);
    const s = await doc(ctx, `hub_summary_${threadId}`);
    expect(s!.content).not.toContain(EMAIL);
  });

  it('writes email and phone lines when third_party_contacts is not selected', async () => {
    const ctx = await createUser(FILTER_CATEGORIES.filter((c) => c !== 'third_party_contacts'));
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak', phone: PHONE, emails: [EMAIL] });
    const threadId = await seedSummary(ctx, record.id);
    await syncAll(ctx);

    const p = await doc(ctx, `hub_person_${record.id}`);
    expect(p!.content).toContain(`Email: ${EMAIL}`);
    expect(p!.content).toContain(`Phone: ${PHONE}`);
    const s = await doc(ctx, `hub_summary_${threadId}`);
    expect(s!.content).toContain(`<${EMAIL}>`);
  });
});

describe('hub.sync: failures (FR-026)', () => {
  it('a store error sets failed with a code and backoff; content stays; a later success sends the current state', async () => {
    const fake = createFakeSupermemoryV3({ apiKey: 'k' });
    let down = true;
    const v3 = new SupermemoryV3Adapter({
      baseUrl: 'http://fake-v3.test',
      apiKey: 'k',
      fetchImpl: (async (...args: Parameters<typeof fetch>) =>
        down
          ? new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
          : fake.fetch(...args)) as typeof fetch,
      sleep: async () => undefined,
      processingPollMs: 0,
    });
    const h = createHubSyncHandler({ store: v3, classifier });
    const ctx = await createUser();
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak', description: 'First version.' });
    const note = await notes.create(ctx, 'person', record.id, { title: 'Plan', body: noteBody('Keep this text safe.') });

    await makeDue(ctx.userId);
    const before = Date.now();
    await runSync(ctx, h);

    const failed = await syncRow(ctx.userId, `hub_person_${record.id}`);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, last_error_code: 'supermemory_http_500', synced_version: 0 });
    // 5 s +/- 20% for the first attempt.
    expect(failed!.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(before + 3_900);
    expect(failed!.lease_until).toBeNull();
    expect((await syncRow(ctx.userId, `hub_note_${note.id}`))!.status).toBe('failed');
    // Postgres keeps the content.
    expect((await notes.get(ctx, note.id)).body).toEqual(noteBody('Keep this text safe.'));

    // A second failure counts another attempt (no maximum).
    await makeDue(ctx.userId);
    await runSync(ctx, h);
    expect((await syncRow(ctx.userId, `hub_person_${record.id}`))!.attempts).toBe(2);

    await records.patch(ctx, 'person', record.id, { description: 'Second version.' });
    down = false;
    await syncAll(ctx, h);

    const stored = await syncRow(ctx.userId, `hub_person_${record.id}`);
    expect(stored).toMatchObject({ status: 'stored', attempts: 0, last_error_code: null });
    const remote = await v3.getDocument(ns(ctx), `hub_person_${record.id}`);
    expect(remote!.content).toContain('Second version.');
    expect(remote!.content).not.toContain('First version.');
    expect((await v3.getDocument(ns(ctx), `hub_note_${note.id}`))!.content).toContain('Keep this text safe.');
  });

  it('MemoryStoreBusyError retries in 10 s without counting an attempt', async () => {
    let busyOnce = true;
    const busyStore: MemoryStore = Object.assign(Object.create(store) as MemoryStore, {
      async addDocuments(nsName: string, docs: MemoryDoc[]) {
        if (busyOnce) {
          busyOnce = false;
          throw new MemoryStoreBusyError('addDocuments');
        }
        return store.addDocuments(nsName, docs);
      },
    });
    const h = createHubSyncHandler({ store: busyStore, classifier });
    const ctx = await createUser();
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak' });

    await makeDue(ctx.userId);
    const before = Date.now();
    await runSync(ctx, h);

    const row = await syncRow(ctx.userId, `hub_person_${record.id}`);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error_code: null });
    expect(row!.next_attempt_at!.getTime()).toBeGreaterThanOrEqual(before + 9_000);
    expect(row!.next_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now() + 11_000);

    await syncAll(ctx, h);
    expect((await syncRow(ctx.userId, `hub_person_${record.id}`))!.status).toBe('stored');
  });

  it('a version bump during the write leaves the row pending', async () => {
    const ctx = await createUser();
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak' });
    const docId = `hub_person_${record.id}`;
    let bumped = false;
    const bumpingStore: MemoryStore = Object.assign(Object.create(store) as MemoryStore, {
      async addDocuments(nsName: string, docs: MemoryDoc[]) {
        if (!bumped) {
          bumped = true;
          // What markDirty does for a concurrent edit: version + 1, due in 2 s.
          await q(
            `update hub_sync_item set version = version + 1, status = 'pending', next_attempt_at = now() + interval '2 seconds'
             where user_id = $1 and doc_id = $2`,
            [ctx.userId, docId],
          );
        }
        return store.addDocuments(nsName, docs);
      },
    });
    const h = createHubSyncHandler({ store: bumpingStore, classifier });

    await makeDue(ctx.userId);
    const { requeued, job } = await runSync(ctx, h);

    const row = await syncRow(ctx.userId, docId);
    expect(row!.status).toBe('pending');
    expect(row!.synced_version).toBeLessThan(row!.version);
    expect(row!.lease_until).toBeNull();
    // The bumped row is due within the 2 s delay: the job re-enqueues itself.
    expect(requeued).toBe(true);
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
  });
});

describe('hub.sync: refilter_pending (fail-closed, constitution VI)', () => {
  it('never claims or sends a row waiting for hub.refilter, and the sweep skips it', async () => {
    const ctx = await createUser();
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak', description: 'Old policy text.' });
    const docId = `hub_person_${record.id}`;
    await q(
      `update hub_sync_item set status = 'pending', last_error_code = 'refilter_pending', next_attempt_at = now()
       where user_id = $1 and doc_id = $2`,
      [ctx.userId, docId],
    );

    const { requeued } = await runSync(ctx);
    expect(requeued).toBe(false);
    expect(await doc(ctx, docId)).toBeNull();
    expect(await syncRow(ctx.userId, docId)).toMatchObject({
      status: 'pending',
      last_error_code: 'refilter_pending',
      synced_version: 0,
      lease_until: null,
    });

    vi.mocked(enqueue).mockClear();
    await hubSyncSweep();
    const swept = vi.mocked(enqueue).mock.calls.filter((c) => c[0] === 'hub.sync' && (c[1] as SyncPayload).userId === ctx.userId);
    expect(swept).toHaveLength(0);
  });
});

describe('hub.sync: fan-out (FR-025)', () => {
  it('rename and link changes reach notes, files, linked records and attached summaries', async () => {
    const ctx = await createUser();
    const { record: person } = await records.create(ctx, 'person', { name: 'Anna Nowak' });
    const { record: company } = await records.create(ctx, 'company', { name: 'Acme Orchard' });
    const { record: project } = await records.create(ctx, 'project', { name: 'Harvest 2026' });
    await links.create(ctx, { kind: 'person_company', personId: person.id, companyId: company.id, role: 'CTO' });
    const note = await notes.create(ctx, 'person', person.id, { title: 'Kickoff', body: noteBody('Orchard notes.') });
    const fileId = await seedFile(ctx, person.id, 'Planting schedule for the orchard.');
    const threadId = await seedSummary(ctx, person.id);
    await syncAll(ctx);

    expect((await doc(ctx, `hub_company_${company.id}`))!.content).toContain('People: Anna Nowak (CTO)');
    expect((await doc(ctx, `hub_file_${fileId}`))!.content).toContain('Planting schedule for the orchard.');

    await records.patch(ctx, 'person', person.id, { name: 'Anna Kowalska' });
    for (const id of [`hub_person_${person.id}`, `hub_note_${note.id}`, `hub_file_${fileId}`, `hub_company_${company.id}`, `hub_summary_${threadId}`]) {
      expect((await syncRow(ctx.userId, id))!.status).toBe('pending');
    }
    await syncAll(ctx);

    expect((await doc(ctx, `hub_person_${person.id}`))!.content).toContain('# Person: Anna Kowalska');
    expect((await doc(ctx, `hub_person_${person.id}`))!.content).toContain('Companies: Acme Orchard (CTO)');
    expect((await doc(ctx, `hub_note_${note.id}`))!.content).toContain('Belongs to: person Anna Kowalska');
    expect((await doc(ctx, `hub_file_${fileId}`))!.content).toContain('Belongs to: person Anna Kowalska');
    expect((await doc(ctx, `hub_company_${company.id}`))!.content).toContain('People: Anna Kowalska (CTO)');
    expect((await doc(ctx, `hub_summary_${threadId}`))!.content).toContain('Anna Kowalska');

    await links.create(ctx, { kind: 'person_project', personId: person.id, projectId: project.id });
    await syncAll(ctx);

    expect((await doc(ctx, `hub_project_${project.id}`))!.content).toContain('People: Anna Kowalska');
    expect((await doc(ctx, `hub_person_${person.id}`))!.content).toContain('Projects: Harvest 2026');
    const noteMeta = (await doc(ctx, `hub_note_${note.id}`))!.metadata;
    expect(noteMeta.vs_hub_linked_keys).toEqual(
      expect.arrayContaining([`person:${person.id}`, `company:${company.id}`, `project:${project.id}`]),
    );
    expect((await doc(ctx, `hub_note_${note.id}`))!.content).toContain('Harvest 2026');
  });

  it('delete tombstones the record tree and removes the documents; not-found counts as success', async () => {
    const ctx = await createUser();
    const { record: person } = await records.create(ctx, 'person', { name: 'Anna Nowak' });
    const { record: company } = await records.create(ctx, 'company', { name: 'Acme Orchard' });
    await links.create(ctx, { kind: 'person_company', personId: person.id, companyId: company.id });
    const note = await notes.create(ctx, 'person', person.id, { title: 'Kickoff', body: noteBody('Orchard notes.') });
    const fileId = await seedFile(ctx, person.id, 'Planting schedule.');
    await syncAll(ctx);
    expect(await doc(ctx, `hub_note_${note.id}`)).not.toBeNull();

    await records.remove(ctx, 'person', person.id);
    for (const id of [`hub_person_${person.id}`, `hub_note_${note.id}`, `hub_file_${fileId}`]) {
      expect(await syncRow(ctx.userId, id)).toMatchObject({ deleted: true, status: 'pending' });
    }
    await syncAll(ctx);

    for (const id of [`hub_person_${person.id}`, `hub_note_${note.id}`, `hub_file_${fileId}`]) {
      expect(await doc(ctx, id)).toBeNull();
      expect((await syncRow(ctx.userId, id))!.status).toBe('stored');
    }
    // The linked company is rebuilt without the deleted person.
    expect((await doc(ctx, `hub_company_${company.id}`))!.content).not.toContain('Anna Nowak');

    // A tombstone whose document never existed completes at once.
    const ghost = randomUUID();
    await withTransaction((tx) => tombstone(tx, ctx.userId, 'note', ghost));
    await syncAll(ctx);
    expect((await syncRow(ctx.userId, `hub_note_${ghost}`))!.status).toBe('stored');
  });
});

describe('hub.sync: wake-ups', () => {
  it('re-enqueues itself with delay 2 s while rows remain, and finishes when none do', async () => {
    const ctx = await createUser();
    await records.create(ctx, 'person', { name: 'Anna Nowak' });
    // Not made due: the row is due within the 2 s delay.
    const before = Date.now();
    const first = await runSync(ctx);
    expect(first.requeued).toBe(true);
    expect(first.job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
    const at = first.job.moveToDelayed.mock.calls[0]![0] as number;
    expect(at - before).toBeGreaterThanOrEqual(2_000);
    expect(at - Date.now()).toBeLessThanOrEqual(2_000);

    await makeDue(ctx.userId);
    const second = await runSync(ctx);
    expect(second.requeued).toBe(false);
    expect(second.job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('processes more than one batch of 10', async () => {
    const ctx = await createUser();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await records.create(ctx, 'project', { name: `Project ${i}` })).record.id);
    await syncAll(ctx);
    for (const id of ids) expect((await syncRow(ctx.userId, `hub_project_${id}`))!.status).toBe('stored');
  });

  it('maintenance.hub-sync-sweep enqueues users with due rows', async () => {
    const ctx = await createUser();
    await records.create(ctx, 'person', { name: 'Anna Nowak' });
    const idle = await createUser();
    await makeDue(ctx.userId);
    vi.mocked(enqueue).mockClear();

    await hubSyncSweep();

    const calls = vi.mocked(enqueue).mock.calls.filter((c) => c[0] === 'hub.sync');
    expect(calls).toContainEqual(['hub.sync', { userId: ctx.userId }, expect.objectContaining({ jobId: jobIds.hubSync(ctx.userId) })]);
    expect(calls.some((c) => (c[1] as SyncPayload).userId === idle.userId)).toBe(false);
  });

  it('keeps one pending wake-up per user and accepts a new one once the previous run completed', async () => {
    const prefix = `vs-test-hubsync-${randomUUID()}`;
    const name = 'hub';
    const url = new URL(process.env.REDIS_URL!);
    const connection = { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
    const queue = new Queue(name, { connection, prefix });
    const events = new QueueEvents(name, { connection, prefix });
    await events.waitUntilReady();
    const userId = randomUUID();
    const opts = { ...JOB_OPTIONS['hub.sync'], jobId: jobIds.hubSync(userId) };
    try {
      await queue.add('hub.sync', { userId }, opts);
      await queue.add('hub.sync', { userId }, opts);
      expect(await queue.getWaitingCount()).toBe(1);

      const worker = new Worker(name, async () => 'ok', { connection, prefix });
      const first = await queue.getJob(jobIds.hubSync(userId));
      await first!.waitUntilFinished(events, 10_000);
      await worker.close();

      // A completed wake-up must not swallow the next one (SC-010).
      await queue.add('hub.sync', { userId }, opts);
      expect(await queue.getWaitingCount()).toBe(1);
      const next = await queue.getJob(jobIds.hubSync(userId));
      expect(await next!.getState()).toBe('waiting');
    } finally {
      await queue.obliterate({ force: true });
      await events.close();
      await queue.close();
    }
  });
});

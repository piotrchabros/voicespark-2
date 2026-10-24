import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, FILTER_CATEGORIES, getDb, getPool, user } from '@voicespark/db';
import { resetEnvForTests } from '@voicespark/core/env';
import type { ServiceContext } from '@voicespark/core/errors';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import * as notes from '@voicespark/core/services/hub/notes';
import * as records from '@voicespark/core/services/hub/records';
import type { Classifier } from '@voicespark/filters';
import { InMemoryMemoryStore, namespaceFor } from '@voicespark/integrations/supermemory';
import { createHubSyncHandler } from '../src/processors/hub-sync';

// SC-010 (T153): 99% of 200 saved hub items are `stored` in the memory store within 1 minute while it is available.
// In-memory store, real Postgres; the handler is called directly the way the BullMQ worker would (the 2 s debounce is
// skipped by making the rows due, as hub-sync.integration.test.ts does).
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

const ITEMS = 200;
const SC010_MS = 60_000;

const classifier: Classifier = {
  async classify() {
    return { spans: [], mostlySensitive: false };
  },
};

const store = new InMemoryMemoryStore();
const userIds: string[] = [];
let handler: ReturnType<typeof createHubSyncHandler>;

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

const noteBody = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function fakeJob(payload: SyncPayload) {
  return {
    id: jobIds.hubSync(payload.userId),
    name: 'hub.sync',
    data: payload,
    attemptsMade: 0,
    opts: { attempts: 1 },
    moveToDelayed: vi.fn(async () => undefined),
  } as unknown as Job<SyncPayload, unknown, 'hub.sync'>;
}

beforeAll(async () => {
  await getPool().query('select 1');
  handler = createHubSyncHandler({ store, classifier });
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getPool().query('delete from deletion_request where user_id = any($1::uuid[])', [userIds]);
    await getDb().delete(user).where(inArray(user.id, userIds));
  }
  await closeDb();
});

describe('hub.sync latency (SC-010)', () => {
  it(`99% of ${ITEMS} saved items are stored within 1 minute`, async () => {
    const [row] = await getDb()
      .insert(user)
      .values({ name: 'Hub Latency', email: `hub-sync-latency-${randomUUID()}@example.test` })
      .returning({ id: user.id });
    userIds.push(row!.id);
    const ctx: ServiceContext = { userId: row!.id, role: 'user' };
    await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);

    // Records and notes through the real services (each save marks its sync row dirty); 200 items in total.
    const savedAt = new Map<string, number>();
    const stamp = (docId: string) => savedAt.set(docId, Date.now());
    const first = Date.now();
    const recordCount = 20;
    for (let i = 0; i < recordCount; i++) {
      const { record } = await records.create(ctx, 'person', { name: `Person ${i} Latency` });
      stamp(`hub_person_${record.id}`);
      for (let n = 0; n < (ITEMS - recordCount) / recordCount; n++) {
        const note = await notes.create(ctx, 'person', record.id, { title: `Note ${i}-${n}`, body: noteBody(`Harvest plan ${i}-${n}.`) });
        stamp(`hub_note_${note.id}`);
      }
    }
    const items = await q<{ doc_id: string }>('select doc_id from hub_sync_item where user_id = $1', [ctx.userId]);
    expect(items).toHaveLength(ITEMS);

    // The worker drains the user's due rows; the stored time of each row is recorded when its batch finishes.
    const storedAt = new Map<string, number>();
    for (let pass = 0; pass < 30 && storedAt.size < ITEMS; pass++) {
      await q(`update hub_sync_item set next_attempt_at = now() where user_id = $1 and status <> 'stored'`, [ctx.userId]);
      try {
        await handler(fakeJob({ userId: ctx.userId }), 'token');
      } catch (err) {
        if (!(err instanceof DelayedError)) throw err;
      }
      const now = Date.now();
      for (const r of await q<{ doc_id: string }>(
        `select doc_id from hub_sync_item where user_id = $1 and status = 'stored' and synced_version = version`,
        [ctx.userId],
      ))
        if (!storedAt.has(r.doc_id)) storedAt.set(r.doc_id, now);
    }

    const latencies = items.map((i) => (storedAt.get(i.doc_id) ?? Infinity) - (savedAt.get(i.doc_id) ?? first));
    const within = latencies.filter((ms) => ms <= SC010_MS).length;
    const sorted = [...latencies].sort((a, b) => a - b);
    console.info(
      `hub sync: ${within}/${ITEMS} stored within 60 s; p50=${sorted[Math.floor(ITEMS / 2)]} ms p99=${sorted[Math.ceil(ITEMS * 0.99) - 1]} ms max=${sorted[ITEMS - 1]} ms`,
    );
    expect(within / ITEMS).toBeGreaterThanOrEqual(0.99);

    const docs = await store.listDocuments(namespaceFor(ctx.userId), { page: 1, limit: 1000 });
    expect(docs.documents).toHaveLength(ITEMS);
  }, 180_000);
});

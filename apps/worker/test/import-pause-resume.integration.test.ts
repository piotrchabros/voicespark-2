import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  contentItem,
  contentItemOccurrence,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  importJob,
  syncCursor,
  user,
} from '@voicespark/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import type { ServiceContext } from '@voicespark/core/errors';
import * as sources from '@voicespark/core/services/sources';
import { configureMailAccess } from '@voicespark/core/services/mail-access';
import { createRecordedClassifier } from '@voicespark/filters';
import { InMemoryMemoryStore, namespaceFor } from '@voicespark/integrations/supermemory';
import { createImportHandler } from '../src/processors/import';
import { seedMailbox, uniqueMailbox, type SeedMessage } from './helpers/greenmail';

// SC-011: pause/resume must create 0 duplicates. Deterministic: no BullMQ worker; queued import.page
// payloads are captured in a FIFO and run by hand. Needs Postgres, Redis (per-source lock) and GreenMail.
type PagePayload = JobPayload<'import.page'>;
const fifo: PagePayload[] = [];

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async (name: string, payload: unknown) => {
    if (name === 'import.page') fifo.push(payload as PagePayload);
    return {};
  }),
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

const PER_ACCOUNT = 500;
const SHARED = 100;
const PAGE = 100;

const store = new InMemoryMemoryStore();
const handler = createImportHandler({ store, classifier: createRecordedClassifier() });

// Plain prose only: no digits, no code words, no phone numbers or addresses in bodies.
const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'glade', 'harbor'];
const letters = (n: number) =>
  n
    .toString(8)
    .split('')
    .map((d) => WORDS[Number(d)])
    .join(' ');

function messages(account: 'a' | 'b', to: string): SeedMessage[] {
  const out: SeedMessage[] = [];
  for (let i = 0; i < PER_ACCOUNT; i++) {
    const shared = i < SHARED;
    // Shared messages carry the same Message-ID and identical content in both accounts.
    const key = shared ? `shared-${i}` : `${account}-${i}`;
    const words = letters(shared ? i : i + (account === 'a' ? 1000 : 5000));
    out.push({
      messageId: `<${key}@pause-resume.test>`,
      subject: `Weekly reflections ${words}`,
      from: 'Author Person <author@pause-resume.test>',
      to,
      date: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000),
      body: `Dear friend, I have been thinking about the slow turning of seasons and what ${words} might mean to a quiet gardener. Warm regards.`,
    });
  }
  return out;
}

function fakeJob(payload: PagePayload) {
  return {
    id: jobIds.importPage(payload.sourceId, Date.now()),
    name: 'import.page',
    data: payload,
    attemptsMade: 0,
    opts: { attempts: 5 },
    moveToDelayed: vi.fn(async () => undefined),
    updateData: vi.fn(async () => undefined),
  };
}

const run = (payload: PagePayload) =>
  handler(fakeJob(payload) as unknown as Job<PagePayload, unknown, 'import.page'>, 'token') as Promise<{
    outcome: string;
    processed?: number;
  }>;

function takeFor(sourceId: string): PagePayload {
  const idx = fifo.findIndex((p) => p.sourceId === sourceId);
  expect(idx).toBeGreaterThanOrEqual(0);
  return fifo.splice(idx, 1)[0]!;
}

const userIds: string[] = [];

async function jobFor(sourceId: string) {
  const [row] = await getDb().select().from(importJob).where(eq(importJob.sourceId, sourceId));
  return row!;
}

beforeAll(async () => {
  await getPool().query('select 1');
  configureMailAccess({ imap: { rejectUnauthorized: false } });
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('import pause/resume dedup (SC-011)', () => {
  it(
    'imports 1000 messages with 100 shared Message-IDs as 900 items across a pause and resume',
    async () => {
      const db = getDb();
      const [u] = await db
        .insert(user)
        .values({ name: 'Importer', email: `import-${randomUUID()}@example.test` })
        .returning({ id: user.id });
      const userId = u!.id;
      userIds.push(userId);
      const ctx: ServiceContext = { userId, role: 'user' };
      await db
        .insert(filterPreferences)
        .values({ userId, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });

      const boxA = uniqueMailbox('pause-a');
      const boxB = uniqueMailbox('pause-b');
      await seedMailbox({ user: boxA, messages: messages('a', boxA) });
      await seedMailbox({ user: boxB, messages: messages('b', boxB) });

      const cfg = (username: string) => ({
        host: process.env.GREENMAIL_HOST ?? 'localhost',
        port: 3993,
        tlsMode: 'tls' as const,
        username,
        password: 'password',
      });
      const a = await sources.connectImap(ctx, cfg(boxA));
      const b = await sources.connectImap(ctx, cfg(boxB));
      expect(fifo.map((p) => p.sourceId).sort()).toEqual([a.id, b.id].sort());

      // One page each: checkpoint persisted, 100 processed.
      await run(takeFor(a.id));
      await run(takeFor(b.id));
      for (const id of [a.id, b.id]) {
        const cursors = await db.select().from(syncCursor).where(eq(syncCursor.sourceId, id));
        expect(cursors.some((c) => c.initialCheckpoint !== null)).toBe(true);
        expect((await jobFor(id)).itemsProcessed).toBe(PAGE);
      }

      // Pause A while its next page is in flight.
      const nextA = takeFor(a.id);
      const inFlight = run(nextA);
      const paused = sources.pause(ctx, a.id);
      await Promise.all([inFlight, paused]);

      const pausedSource = await sources.get(ctx, a.id);
      expect(pausedSource.status).toBe('paused');
      const pausedJob = await jobFor(a.id);
      expect(pausedJob.status).toBe('paused');
      // Page-boundary checkpoint only (D-C9).
      expect(pausedJob.itemsProcessed % PAGE).toBe(0);
      const aCursors = await db.select().from(syncCursor).where(eq(syncCursor.sourceId, a.id));
      expect(aCursors.some((c) => c.initialCheckpoint !== null)).toBe(true);

      // No further page for A is runnable while paused.
      for (const p of fifo.filter((x) => x.sourceId === a.id)) {
        expect((await run(p)).outcome).toBe('aborted');
      }
      for (let i = fifo.length - 1; i >= 0; i--) if (fifo[i]!.sourceId === a.id) fifo.splice(i, 1);

      await sources.resume(ctx, a.id);

      // Drain until empty.
      let guard = 0;
      while (fifo.length > 0) {
        expect(++guard).toBeLessThan(200);
        await run(fifo.shift()!);
      }

      const jobA = await jobFor(a.id);
      const jobB = await jobFor(b.id);
      expect(jobA.status).toBe('completed');
      expect(jobB.status).toBe('completed');

      const [{ n }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(contentItem)
        .where(eq(contentItem.userId, userId))) as [{ n: number }];
      expect(n).toBe(900);

      const occ = await db
        .select({ s: contentItemOccurrence.sourceId, r: contentItemOccurrence.providerRef })
        .from(contentItemOccurrence)
        .where(inArray(contentItemOccurrence.sourceId, [a.id, b.id]));
      expect(new Set(occ.map((o) => `${o.s}|${o.r}`)).size).toBe(occ.length);
      expect(occ.length).toBe(1000);

      expect(jobA.itemsDuplicate + jobB.itemsDuplicate).toBe(SHARED);

      const ids: string[] = [];
      for (let page = 1; ; page++) {
        const res = await store.listDocuments(namespaceFor(userId), { page, limit: 100 });
        ids.push(...res.documents.map((d) => d.id));
        if (!res.hasMore) break;
      }
      expect(ids.length).toBe(900);
      expect(new Set(ids).size).toBe(900);
    },
    300_000,
  );
});

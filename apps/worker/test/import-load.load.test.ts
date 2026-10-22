import { randomUUID } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  contentItem,
  contentItemOccurrence,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  importJob,
  user,
} from '@voicespark/db';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  closeQueues,
  getQueue,
  getRedisConnection,
  jobIds,
  QUEUE_PREFIX,
  QUEUES,
  removeScheduler,
  type JobPayload,
} from '@voicespark/core/queues';
import type { ServiceContext } from '@voicespark/core/errors';
import { configureMailAccess } from '@voicespark/core/services/mail-access';
import * as sources from '@voicespark/core/services/sources';
import { createRecordedClassifier } from '@voicespark/filters';
import { InMemoryMemoryStore, namespaceFor } from '@voicespark/integrations/supermemory';
import { createImportHandler, type ImportPageOutcome } from '../src/processors/import';
import { GREENMAIL_HOST, GREENMAIL_IMAPS_PORT, uniqueMailbox } from './helpers/greenmail';
import { generateLoadMail, seedLoadMail } from './helpers/load-mail';

// T163 / SC-003: 10,000 messages over three IMAP mailboxes (500 shared between two of them) import at >= 4 items/s
// per mailbox and under one hour, with no duplicate documents. Real BullMQ workers run in-process against the test
// Redis (nothing is mocked); GreenMail is the mail server, the memory store is in-memory and the classifier recorded.
// Run with `pnpm test:import-load` (excluded from test:integration). IMPORT_LOAD_MESSAGES / IMPORT_LOAD_SHARED shrink
// the data set for a quick local run; the SC-003 numbers are the defaults.
process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const TOTAL = Number(process.env.IMPORT_LOAD_MESSAGES ?? 10_000);
const SHARED = Number(process.env.IMPORT_LOAD_SHARED ?? 500);
const CONCURRENCY = 8;
const MIN_ITEMS_PER_SECOND = 4;
const MAX_TOTAL_MS = 3_600_000;
/** Jobs still non-terminal with an empty import queue for this long means pages were lost. */
const STALL_MS = 120_000;
const POLL_MS = 2_000;

type PagePayload = JobPayload<'import.page'>;
type PageJob = Job<PagePayload, unknown, 'import.page'>;

interface PageStats {
  outcomes: Partial<Record<ImportPageOutcome, number>>;
  durationsMs: number[];
  failures: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

const userIds: string[] = [];

beforeAll(async () => {
  await getPool().query('select 1');
  await getRedisConnection().ping();
  configureMailAccess({ imap: { rejectUnauthorized: false } });
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeQueues();
  await closeDb();
});

describe('import load (T163, SC-003)', () => {
  it(`imports ${TOTAL} messages over 3 mailboxes (${SHARED} shared) at >= ${MIN_ITEMS_PER_SECOND} items/s per mailbox`, async () => {
    const boxes = generateLoadMail({
      total: TOTAL,
      shared: SHARED,
      users: [uniqueMailbox('load-a'), uniqueMailbox('load-b'), uniqueMailbox('load-c')],
    });
    const seedStarted = Date.now();
    await seedLoadMail(boxes);
    console.info({ phase: 'seed', messages: TOTAL, ms: Date.now() - seedStarted });

    const db = getDb();
    const [u] = await db
      .insert(user)
      .values({ name: 'Load Importer', email: `import-load-${randomUUID()}@example.test` })
      .returning({ id: user.id });
    const userId = u!.id;
    userIds.push(userId);
    const ctx: ServiceContext = { userId, role: 'user' };
    await db
      .insert(filterPreferences)
      .values({ userId, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });

    const store = new InMemoryMemoryStore();
    const handler = createImportHandler({ store, classifier: createRecordedClassifier() });
    const stats: PageStats = { outcomes: {}, durationsMs: [], failures: 0 };
    const connection = getRedisConnection();
    const importWorker = new Worker<PagePayload, unknown, 'import.page'>(
      QUEUES.import,
      (job, token) => handler(job as PageJob, token),
      { connection, prefix: QUEUE_PREFIX, concurrency: CONCURRENCY },
    );
    importWorker.on('completed', (job, result) => {
      const { outcome } = result as { outcome: ImportPageOutcome };
      stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
      if (job.finishedOn && job.processedOn)
        stats.durationsMs.push(job.finishedOn - job.processedOn);
    });
    importWorker.on('failed', () => {
      stats.failures += 1;
    });
    // `notify.send` jobs (import_completed) are drained without SMTP: delivery is not part of the measurement.
    const notifyWorker = new Worker(QUEUES.notify, async () => ({ emailed: false }), {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: CONCURRENCY,
    });
    await Promise.all([importWorker.waitUntilReady(), notifyWorker.waitUntilReady()]);

    const sourceIds: string[] = [];
    try {
      const connectStarted = Date.now();
      for (const box of boxes) {
        const s = await sources.connectImap(ctx, {
          host: GREENMAIL_HOST,
          port: GREENMAIL_IMAPS_PORT,
          tlsMode: 'tls',
          username: box.user,
          password: 'password',
        });
        sourceIds.push(s.id);
      }

      // Wait for every job to reach a terminal state; a stall (nothing queued, nothing finished) fails early.
      let rows: (typeof importJob.$inferSelect)[] = [];
      let idleSince: number | null = null;
      for (;;) {
        rows = await db.select().from(importJob).where(inArray(importJob.sourceId, sourceIds));
        const open = rows.filter((r) => r.status === 'queued' || r.status === 'running');
        if (rows.length === sourceIds.length && open.length === 0) break;
        if (Date.now() - connectStarted > MAX_TOTAL_MS) break;
        const counts = await getQueue(QUEUES.import).getJobCounts(
          'waiting',
          'active',
          'delayed',
          'prioritized',
        );
        const queued = Object.values(counts).reduce((n, c) => n + (c ?? 0), 0);
        idleSince = queued > 0 ? null : (idleSince ?? Date.now());
        if (idleSince !== null && Date.now() - idleSince > STALL_MS) {
          throw new Error(
            `import stalled: open jobs ${open.length}, queue empty for ${STALL_MS} ms, outcomes ${JSON.stringify(stats.outcomes)}`,
          );
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      const totalMs = Date.now() - connectStarted;

      const perMailbox = rows.map((r) => {
        const seconds =
          r.startedAt && r.finishedAt
            ? (r.finishedAt.getTime() - r.startedAt.getTime()) / 1000
            : NaN;
        return {
          sourceId: r.sourceId,
          status: r.status,
          itemsProcessed: r.itemsProcessed,
          itemsImported: r.itemsImported,
          itemsDuplicate: r.itemsDuplicate,
          itemsExcluded: r.itemsExcluded,
          itemsFailed: r.itemsFailed,
          seconds,
          itemsPerSecond: r.itemsProcessed / seconds,
        };
      });
      const sortedPages = [...stats.durationsMs].sort((a, b) => a - b);
      console.info({
        phase: 'import',
        messages: TOTAL,
        totalMs,
        pages: stats.durationsMs.length,
        pageMsP50: percentile(sortedPages, 50),
        pageMsP95: percentile(sortedPages, 95),
        pageMsMax: sortedPages.at(-1) ?? 0,
        outcomes: stats.outcomes,
        failures: stats.failures,
        mailboxes: perMailbox.map((m) => ({
          itemsProcessed: m.itemsProcessed,
          seconds: Number(m.seconds.toFixed(1)),
          itemsPerSecond: Number(m.itemsPerSecond.toFixed(2)),
        })),
      });

      expect(perMailbox.map((m) => m.status)).toEqual(['completed', 'completed', 'completed']);
      expect(totalMs).toBeLessThan(MAX_TOTAL_MS);
      expect(stats.failures).toBe(0);
      for (const [i, m] of perMailbox.entries()) {
        expect(m.itemsProcessed, `mailbox ${i} processed`).toBe(
          perMailboxExpected(boxes, m.sourceId, sourceIds),
        );
        expect(m.itemsFailed, `mailbox ${i} failed items`).toBe(0);
        expect(m.itemsPerSecond, `mailbox ${i} items/s`).toBeGreaterThanOrEqual(
          MIN_ITEMS_PER_SECOND,
        );
      }
      expect(perMailbox.reduce((n, m) => n + m.itemsDuplicate, 0)).toBe(SHARED);

      const distinct = TOTAL - SHARED;
      const imported = perMailbox.reduce((n, m) => n + m.itemsImported, 0);
      const excluded = perMailbox.reduce((n, m) => n + m.itemsExcluded, 0);
      expect(imported + excluded).toBe(distinct);
      const [{ n: items }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(contentItem)
        .where(eq(contentItem.userId, userId))) as [{ n: number }];
      expect(items).toBe(imported);
      const occ = await db
        .select({ s: contentItemOccurrence.sourceId, r: contentItemOccurrence.providerRef })
        .from(contentItemOccurrence)
        .where(inArray(contentItemOccurrence.sourceId, sourceIds));
      expect(occ.length).toBe(TOTAL);
      expect(new Set(occ.map((o) => `${o.s}|${o.r}`)).size).toBe(TOTAL);

      const ids: string[] = [];
      for (let page = 1; ; page++) {
        const res = await store.listDocuments(namespaceFor(userId), { page, limit: 100 });
        ids.push(...res.documents.map((d) => d.id));
        if (!res.hasMore) break;
      }
      expect(ids.length).toBe(items);
      expect(new Set(ids).size).toBe(items);
    } finally {
      await Promise.all([importWorker.close(), notifyWorker.close()]);
      // Leave the shared test Redis as found: poll schedulers of these sources and any follow-up job of this user.
      for (const id of sourceIds)
        await removeScheduler(QUEUES.syncPoll, jobIds.poll(id)).catch(() => undefined);
      for (const queue of [QUEUES.import, QUEUES.profile, QUEUES.notify]) {
        const jobs = await getQueue(queue).getJobs(['waiting', 'delayed', 'prioritized', 'failed']);
        for (const j of jobs) {
          const data = j.data as { userId?: string; sourceId?: string };
          if (data.userId === userId || (data.sourceId && sourceIds.includes(data.sourceId))) {
            await j.remove().catch(() => undefined);
          }
        }
      }
    }
  }, 3_700_000);
});

/** Messages seeded into the mailbox behind `sourceId` (sources were connected in `boxes` order). */
function perMailboxExpected(
  boxes: ReturnType<typeof generateLoadMail>,
  sourceId: string,
  sourceIds: string[],
): number {
  return boxes[sourceIds.indexOf(sourceId)]!.messages.length;
}

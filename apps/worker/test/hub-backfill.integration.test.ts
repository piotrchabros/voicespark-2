import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  closeDb,
  connectedSource,
  contentItem,
  contentItemOccurrence,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  hubMailboxSetting,
  hubMessageSource,
  user,
} from '@voicespark/db';
import type { ServiceContext } from '@voicespark/core/errors';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import * as hubIngest from '@voicespark/core/services/hub/ingest';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import * as imports from '@voicespark/core/services/imports';
import { configureMailAccess, openFetcher } from '@voicespark/core/services/mail-access';
import * as sources from '@voicespark/core/services/sources';
import { createRecordedClassifier } from '@voicespark/filters';
import type { MailFetcher, MailRef } from '@voicespark/integrations/mail';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import {
  BACKFILL_LOCKED_DELAY_MS,
  BACKFILL_PAGE_SIZE,
  BACKFILL_RETRY_DELAY_MS,
  createHubBackfillHandler,
} from '../src/processors/hub-backfill';
import { webLinkFor } from '../src/hub-links';
import { createImportHandler } from '../src/processors/import';
import { seedMailbox, uniqueMailbox, type SeedMessage } from './helpers/greenmail';

// T116 / contracts/jobs.md (12): `hub.backfill` re-reads mail VoiceSpark already imported (read-only fetch through the
// existing fetcher) and hands each message to `recordMessage`. Deterministic: no BullMQ worker; queued payloads are
// captured and run by hand. Needs Postgres, Redis (per-source lock) and GreenMail.
type PagePayload = JobPayload<'import.page'>;
type BackfillPayload = JobPayload<'hub.backfill'>;
const pages: PagePayload[] = [];
const backfills: Array<{ payload: BackfillPayload; jobId?: string }> = [];

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async (name: string, payload: unknown, opts?: { jobId?: string }) => {
    if (name === 'import.page') pages.push(payload as PagePayload);
    if (name === 'hub.backfill') backfills.push({ payload: payload as BackfillPayload, jobId: opts?.jobId });
    return {};
  }),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

vi.mock('@voicespark/core/services/hub/ingest', async (importOriginal) => {
  const real = await importOriginal<typeof import('@voicespark/core/services/hub/ingest')>();
  return { ...real, recordMessage: vi.fn(real.recordMessage) };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const TOTAL = 230;
const recordMessage = vi.mocked(hubIngest.recordMessage);

/** Batches handed to `fetchMessages`, to check the page size and that only stored refs are fetched. */
const fetchBatches: MailRef[][] = [];
const recordingFetcher = async (sourceId: string): Promise<MailFetcher> => {
  const f = await openFetcher(sourceId);
  return {
    ...f,
    provider: f.provider,
    getAddress: () => f.getAddress(),
    listFolders: () => {
      throw new Error('backfill must not list folders');
    },
    listPage: () => {
      throw new Error('backfill must not list pages');
    },
    fetchMessages: (refs) => {
      fetchBatches.push(refs);
      return f.fetchMessages(refs);
    },
    close: () => f.close(),
  };
};

const deps = { store: new InMemoryMemoryStore(), classifier: createRecordedClassifier() };
const importHandler = createImportHandler(deps);
const backfillHandler = createHubBackfillHandler({ ...deps, openFetcher: recordingFetcher });

const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'glade', 'harbor'];
const letters = (n: number) =>
  n
    .toString(8)
    .split('')
    .map((d) => WORDS[Number(d)])
    .join(' ');

function messages(to: string): SeedMessage[] {
  return Array.from({ length: TOTAL }, (_, i) => ({
    messageId: `<backfill-${i}-${randomUUID()}@backfill.example>`,
    subject: `Garden notes ${letters(i)}`,
    from: 'Gardener Person <gardener@backfill.example>',
    to,
    date: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000),
    body: `Dear friend, the ${letters(i)} beds are resting under the snow this week. Warm regards.`,
  }));
}

async function runImport(payload: PagePayload): Promise<void> {
  const job = {
    id: jobIds.importPage(payload.sourceId, Date.now()),
    name: 'import.page',
    data: payload,
    attemptsMade: 0,
    opts: { attempts: 5 },
    moveToDelayed: vi.fn(async () => undefined),
    updateData: vi.fn(async () => undefined),
  };
  await importHandler(job as unknown as Job<PagePayload, unknown, 'import.page'>, 'token');
}

interface BackfillRun {
  outcome: string;
  recorded: number;
  delayMs: number | null;
}

async function runBackfill(payload: BackfillPayload): Promise<BackfillRun> {
  let calledAt = 0;
  const moveToDelayed = vi.fn(async (_ts: number, _token?: string) => {
    calledAt = Date.now();
  });
  const job = {
    id: jobIds.hubBackfill(payload.sourceId),
    name: 'hub.backfill',
    data: payload,
    attemptsMade: 0,
    opts: { attempts: 5 },
    moveToDelayed,
  };
  try {
    const r = (await backfillHandler(job as unknown as Job<BackfillPayload, unknown, 'hub.backfill'>, 'token')) as {
      outcome: string;
      recorded: number;
    };
    expect(moveToDelayed).not.toHaveBeenCalled();
    return { outcome: r.outcome, recorded: r.recorded, delayMs: null };
  } catch (err) {
    expect(err).toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    const [ts, token] = moveToDelayed.mock.calls[0]!;
    expect(token).toBe('token');
    // Measured at the moment the handler requested the delay, so slow page fetches do not count.
    const delayMs = ts - calledAt;
    // `recorded` is not visible through the re-delay; the spy counts calls instead.
    return { outcome: 'delayed', recorded: -1, delayMs };
  }
}

/** `delayMs` is the delay the handler requested (target minus the time it called moveToDelayed). */
function expectDelay(r: BackfillRun, delayMs: number): void {
  // The handler reads Date.now() just before calling moveToDelayed, so allow a few ms of skew.
  expect(r.delayMs).toBeGreaterThanOrEqual(delayMs - 50);
  expect(r.delayMs).toBeLessThan(delayMs + 1_000);
}

async function setting(sourceId: string) {
  const [row] = await getDb().select().from(hubMailboxSetting).where(eq(hubMailboxSetting.sourceId, sourceId));
  return row!;
}

async function messageSourceCount(sourceId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(hubMessageSource)
    .where(eq(hubMessageSource.sourceId, sourceId));
  return row!.n;
}

/** Provider refs of the source's active parent emails, newest item first (the backfill order). */
async function refsNewestFirst(sourceId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ ref: contentItemOccurrence.providerRef })
    .from(contentItemOccurrence)
    .innerJoin(contentItem, eq(contentItem.id, contentItemOccurrence.contentItemId))
    .where(and(eq(contentItemOccurrence.sourceId, sourceId), eq(contentItem.kind, 'email')))
    .orderBy(desc(contentItem.itemDate), desc(contentItemOccurrence.id));
  return rows.map((r) => r.ref);
}

const userIds: string[] = [];
let ctx: ServiceContext;
let sourceId: string;
let payload: BackfillPayload;

beforeAll(async () => {
  await getPool().query('select 1');
  configureMailAccess({ imap: { rejectUnauthorized: false } });

  const db = getDb();
  const [u] = await db
    .insert(user)
    .values({ name: 'Backfiller', email: `backfill-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(u!.id);
  ctx = { userId: u!.id, role: 'user' };
  await db
    .insert(filterPreferences)
    .values({ userId: ctx.userId, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });

  const box = uniqueMailbox('backfill');
  await seedMailbox({ user: box, messages: messages(box) });
  const source = await sources.connectImap(ctx, {
    host: process.env.GREENMAIL_HOST ?? 'localhost',
    port: 3993,
    tlsMode: 'tls',
    username: box,
    password: 'password',
  });
  sourceId = source.id;
  payload = { userId: ctx.userId, sourceId };

  // Import everything first (the hub is off): the backfill only covers mail VoiceSpark already imported.
  let guard = 0;
  while (pages.length > 0) {
    expect(++guard).toBeLessThan(50);
    await runImport(pages.shift()!);
  }
  expect((await refsNewestFirst(sourceId)).length).toBe(TOTAL);
  expect(recordMessage).not.toHaveBeenCalled();
}, 300_000);

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

beforeEach(() => {
  recordMessage.mockClear();
  fetchBatches.length = 0;
  backfills.length = 0;
});

describe('hub.backfill (contracts/jobs.md (12))', () => {
  it('builds the Gmail open-original link and none for IMAP or Graph', () => {
    expect(webLinkFor('gmail', '18c2f0a1b2c3d4e5')).toBe('https://mail.google.com/mail/#all/18c2f0a1b2c3d4e5');
    expect(webLinkFor('imap', 'INBOX|1|7')).toBeNull();
    expect(webLinkFor('microsoft', 'AAMk')).toBeNull();
  });

  it('stops without fetching while the hub is off for the source', async () => {
    expect(await runBackfill(payload)).toMatchObject({ outcome: 'stopped', delayMs: null });
    expect(fetchBatches).toHaveLength(0);
    expect(recordMessage).not.toHaveBeenCalled();
  });

  it('pages 100 at a time newest first, keeps the cursor and moves pending -> running -> done', async () => {
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    expect(backfills).toEqual([{ payload, jobId: jobIds.hubBackfill(sourceId) }]);
    expect((await setting(sourceId)).backfillState).toBe('pending');

    const expected = await refsNewestFirst(sourceId);

    // Page 1: re-delays itself (same job) for the next page and leaves the source lock free in between.
    const first = await runBackfill(payload);
    expect(first.outcome).toBe('delayed');
    expectDelay(first, 0);
    expect(fetchBatches.map((b) => b.length)).toEqual([BACKFILL_PAGE_SIZE]);
    expect(recordMessage.mock.calls.map(([a]) => a.providerRef)).toEqual(expected.slice(0, BACKFILL_PAGE_SIZE));
    const s1 = await setting(sourceId);
    expect(s1.backfillState).toBe('running');
    expect(s1.backfillCursor).toMatchObject({ itemDate: expect.any(String), id: expect.any(String) });
    const lock = await imports.acquireSourceLock(sourceId);
    expect(lock).not.toBeNull();
    await lock!();

    const call = recordMessage.mock.calls[0]![0];
    expect(call).toMatchObject({
      userId: ctx.userId,
      sourceId,
      providerRef: expected[0],
      folders: ['INBOX'],
      direction: 'inbound',
      webLink: null,
    });
    expect(call.parsed.messageId).toMatch(/@backfill\.example>?$/);

    // Page 2, then the last partial page finishes the backfill.
    expect((await runBackfill(payload)).outcome).toBe('delayed');
    expect((await setting(sourceId)).backfillState).toBe('running');
    expect(await runBackfill(payload)).toMatchObject({ outcome: 'done', recorded: TOTAL - 2 * BACKFILL_PAGE_SIZE });
    expect(fetchBatches.map((b) => b.length)).toEqual([100, 100, 30]);
    expect(recordMessage.mock.calls.map(([a]) => a.providerRef)).toEqual(expected);
    expect((await setting(sourceId)).backfillState).toBe('done');
    expect(await messageSourceCount(sourceId)).toBe(TOTAL);

    // A finished backfill does nothing more.
    recordMessage.mockClear();
    expect(await runBackfill(payload)).toMatchObject({ outcome: 'stopped' });
    expect(recordMessage).not.toHaveBeenCalled();
  }, 120_000);

  it('is idempotent: a re-enable re-runs over the same refs without new message sources', async () => {
    await mailboxes.disable(ctx, sourceId, { hubData: 'keep' });
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    const s = await setting(sourceId);
    expect(s.backfillState).toBe('pending');
    expect(s.backfillCursor).toBeNull();

    let guard = 0;
    for (;;) {
      expect(++guard).toBeLessThan(10);
      if ((await runBackfill(payload)).outcome === 'done') break;
    }
    expect(recordMessage).toHaveBeenCalledTimes(TOTAL);
    expect(await messageSourceCount(sourceId)).toBe(TOTAL);
    expect((await setting(sourceId)).backfillState).toBe('done');
  }, 120_000);

  it('waits briefly while an import page holds the source lock', async () => {
    await mailboxes.disable(ctx, sourceId, { hubData: 'keep' });
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    const release = await imports.acquireSourceLock(sourceId);
    expect(release).not.toBeNull();
    try {
      const r = await runBackfill(payload);
      expect(r.outcome).toBe('delayed');
      expectDelay(r, BACKFILL_LOCKED_DELAY_MS);
      expect(fetchBatches).toHaveLength(0);
      expect(recordMessage).not.toHaveBeenCalled();
    } finally {
      await release!();
    }
    expect((await setting(sourceId)).backfillState).toBe('pending');
  });

  it('reschedules in 15 min without changing the state when the source is paused or needs reconnection', async () => {
    await sources.pause(ctx, sourceId);
    const paused = await runBackfill(payload);
    expect(paused.outcome).toBe('delayed');
    expectDelay(paused, BACKFILL_RETRY_DELAY_MS);
    await sources.resume(ctx, sourceId);
    pages.length = 0;

    await getDb().update(connectedSource).set({ status: 'needs_reconnection' }).where(eq(connectedSource.id, sourceId));
    const reconnect = await runBackfill(payload);
    expect(reconnect.outcome).toBe('delayed');
    expectDelay(reconnect, BACKFILL_RETRY_DELAY_MS);
    await getDb().update(connectedSource).set({ status: 'connected' }).where(eq(connectedSource.id, sourceId));

    expect(fetchBatches).toHaveLength(0);
    expect(recordMessage).not.toHaveBeenCalled();
    expect((await setting(sourceId)).backfillState).toBe('pending');
  });

  it('stops when the hub is disabled mid-backfill and leaves the cursor alone', async () => {
    expect((await runBackfill(payload)).outcome).toBe('delayed');
    const before = await setting(sourceId);
    expect(before.backfillState).toBe('running');
    await mailboxes.disable(ctx, sourceId, { hubData: 'keep' });
    recordMessage.mockClear();
    expect(await runBackfill(payload)).toMatchObject({ outcome: 'stopped', delayMs: null });
    expect(recordMessage).not.toHaveBeenCalled();
    const after = await setting(sourceId);
    expect(after.backfillState).toBe('running');
    expect(after.backfillCursor).toEqual(before.backfillCursor);
  }, 120_000);
});

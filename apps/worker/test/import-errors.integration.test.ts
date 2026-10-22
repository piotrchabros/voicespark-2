import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connectedSource,
  contentItem,
  contentItemOccurrence,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  importJob,
  notification,
  syncCursor,
  user,
} from '@voicespark/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { closeQueues, jobIds, type JobPayload } from '@voicespark/core/queues';
import type { ServiceContext } from '@voicespark/core/errors';
import * as imports from '@voicespark/core/services/imports';
import * as sources from '@voicespark/core/services/sources';
import { createRecordedClassifier } from '@voicespark/filters';
import {
  HistoryExpiredError,
  MailAuthError,
  RateLimitedError,
  UidValidityChangedError,
  type FetchedMessage,
  type FolderState,
  type ImportMode,
  type MailFetcher,
  type MailFolder,
  type MailPageResult,
  type MailRef,
} from '@voicespark/integrations/mail';
import {
  InMemoryMemoryStore,
  namespaceFor,
  type MemoryDoc,
} from '@voicespark/integrations/supermemory';
import { createImportHandler } from '../src/processors/import';

// import.page error paths (jobs.md behavior 1, D-C6/D-C9) over a scripted MailFetcher (`openFetcher` override): the
// provider errors every client maps to (Gmail 401/429/404, Graph 401/429/410, IMAP UIDVALIDITY) reach the processor as
// the shared mail error classes, so no mail server is needed. Needs Postgres and Redis (per-source lock). Queued
// import.page payloads are captured in a FIFO and run by hand.
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

// Inspection runs between the dedup lookup and the content write of each message; a test can hold messages there to
// make a page-internal race deterministic (concurrent same-Message-ID writers, a pause landing mid-page).
const inspectGate = vi.hoisted(() => ({ wait: async (): Promise<void> => undefined }));

vi.mock('@voicespark/core/services/inspection', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@voicespark/core/services/inspection')>();
  return {
    ...mod,
    inspectForUser: async (...args: Parameters<typeof mod.inspectForUser>) => {
      await inspectGate.wait();
      return mod.inspectForUser(...args);
    },
  };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const classifier = createRecordedClassifier();

// Plain prose only: no digits, no code words, no phone numbers or addresses in bodies.
const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'glade', 'harbor'];
const letters = (n: number) =>
  n
    .toString(8)
    .split('')
    .map((d) => WORDS[Number(d)])
    .join(' ');

function rawMessage(opts: { messageId: string; seq: number; to: string }): Buffer {
  const words = letters(opts.seq + 64);
  return Buffer.from(
    [
      `Message-ID: <${opts.messageId}@import-errors.test>`,
      `Date: ${new Date(Date.UTC(2024, 0, 1) + opts.seq * 3_600_000).toUTCString()}`,
      'From: Author Person <author@import-errors.test>',
      `To: ${opts.to}`,
      `Subject: Weekly reflections ${words}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      `Dear friend, I have been thinking about the slow turning of seasons and what ${words} might mean to a quiet gardener. Warm regards.`,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

interface ScriptedFolder extends MailFolder {
  /** Index = UID - 1. */
  messages: Buffer[];
}

interface ScriptedFetcher extends MailFetcher {
  readonly pages: { folderKey: string; mode: ImportMode }[];
  /** Thrown (or returned per message, see `fetchErrorAsValue`) by the next calls until cleared. */
  listPageError: ((folder: FolderState, mode: ImportMode) => Error | undefined) | undefined;
  fetchError: Error | undefined;
  fetchErrorAsValue: boolean;
}

/** In-memory mailbox with IMAP-like UIDs: `initial`/`resync` walk from `uidNext`, `incremental` from `lastUid`. */
function scriptedFetcher(folders: ScriptedFolder[], pageSize: number): ScriptedFetcher {
  const byKey = new Map(folders.map((f) => [f.folderKey, f]));
  const refsOf = (folderKey: string, uids: number[]): MailRef[] =>
    uids.map((uid) => ({ providerRef: `${folderKey}|${uid}`, folderKey }));
  const fetcher: ScriptedFetcher = {
    provider: 'imap',
    pages: [],
    listPageError: undefined,
    fetchError: undefined,
    fetchErrorAsValue: false,
    async getAddress() {
      return 'owner@import-errors.test';
    },
    async listFolders() {
      return folders.map(({ folderKey, name, authored }) => ({ folderKey, name, authored }));
    },
    async listPage(folder, { mode, limit }): Promise<MailPageResult> {
      fetcher.pages.push({ folderKey: folder.folderKey, mode });
      const err = fetcher.listPageError?.(folder, mode);
      if (err) throw err;
      const box = byKey.get(folder.folderKey)!;
      const size = Math.min(pageSize, limit);
      const uidValidity = '1';
      if (mode === 'incremental') {
        const cursor = folder.cursor;
        if (!cursor || !('uidValidity' in cursor)) throw new Error('imap_missing_cursor');
        const uids = box.messages.map((_, i) => i + 1).filter((u) => u > cursor.lastUid);
        const page = uids.slice(0, size);
        return {
          refs: refsOf(box.folderKey, page),
          state: { ...folder, cursor: { uidValidity, lastUid: page.at(-1) ?? cursor.lastUid } },
          folderDone: uids.length <= size,
        };
      }
      const checkpoint = folder.initialCheckpoint;
      const from = checkpoint && 'uidNext' in checkpoint ? checkpoint.uidNext : 1;
      const uids = box.messages.map((_, i) => i + 1).filter((u) => u >= from);
      const page = uids.slice(0, size);
      if (uids.length > size) {
        return {
          refs: refsOf(box.folderKey, page),
          state: {
            ...folder,
            initialCheckpoint: { uidNext: page.at(-1)! + 1 },
            initialComplete: false,
          },
          folderDone: false,
          totalEstimate: uids.length,
        };
      }
      return {
        refs: refsOf(box.folderKey, page),
        state: {
          folderKey: box.folderKey,
          initialCheckpoint: null,
          cursor: { uidValidity, lastUid: box.messages.length },
          initialComplete: true,
        },
        folderDone: true,
        totalEstimate: uids.length,
      };
    },
    async fetchMessages(refs) {
      const out = new Map<string, FetchedMessage | Error>();
      if (fetcher.fetchError && !fetcher.fetchErrorAsValue) throw fetcher.fetchError;
      for (const r of refs) {
        if (fetcher.fetchError) {
          out.set(r.providerRef, fetcher.fetchError);
          continue;
        }
        const [folderKey, uid] = r.providerRef.split('|') as [string, string];
        const box = byKey.get(folderKey)!;
        const raw = box.messages[Number(uid) - 1];
        out.set(
          r.providerRef,
          raw
            ? { raw, folders: [folderKey], isSent: box.authored }
            : new Error('message_not_found'),
        );
      }
      return out;
    },
    async close() {},
  };
  return fetcher;
}

/** A store whose `addDocuments` fails while `down` is set. */
class FlakyStore extends InMemoryMemoryStore {
  down = false;
  override async addDocuments(ns: string, docs: MemoryDoc[]) {
    if (this.down) throw new Error('supermemory_unavailable');
    return super.addDocuments(ns, docs);
  }
}

/** Resolves every waiter once `n` have arrived, after `beforeRelease` ran. */
function barrier(
  n: number,
  beforeRelease: () => Promise<void> = async () => undefined,
): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return async () => {
    if (++arrived === n) await beforeRelease().finally(release);
    await open;
  };
}

function fakeJob(payload: PagePayload, attemptsMade = 0) {
  return {
    id: jobIds.importPage(payload.sourceId, Date.now()),
    name: 'import.page',
    data: payload,
    attemptsMade,
    opts: { attempts: 5 },
    moveToDelayed: vi.fn(async () => undefined),
    updateData: vi.fn(async () => undefined),
  };
}

type Outcome = { outcome: string; processed?: number };
type Runner = (
  payload: PagePayload,
  attemptsMade?: number,
) => { job: ReturnType<typeof fakeJob>; result: Promise<Outcome> };

function runner(fetcher: MailFetcher, store: InMemoryMemoryStore): Runner {
  const handler = createImportHandler({ store, classifier, openFetcher: async () => fetcher });
  return (payload, attemptsMade = 0) => {
    const job = fakeJob(payload, attemptsMade);
    const result = handler(
      job as unknown as Job<PagePayload, unknown, 'import.page'>,
      'token',
    ) as Promise<Outcome>;
    return { job, result };
  };
}

function takeFor(sourceId: string): PagePayload {
  const idx = fifo.findIndex((p) => p.sourceId === sourceId);
  expect(idx).toBeGreaterThanOrEqual(0);
  return fifo.splice(idx, 1)[0]!;
}

const userIds: string[] = [];

async function newUser(): Promise<{ userId: string; ctx: ServiceContext }> {
  const db = getDb();
  const [u] = await db
    .insert(user)
    .values({ name: 'Importer', email: `import-errors-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  const userId = u!.id;
  userIds.push(userId);
  await db
    .insert(filterPreferences)
    .values({ userId, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: new Date() });
  return { userId, ctx: { userId, role: 'user' } };
}

/** A connected IMAP source with a `queued` job; the credential is never read because `openFetcher` is overridden. */
async function newSource(
  userId: string,
  kind: 'initial' | 'incremental' = 'initial',
): Promise<{ sourceId: string; importJobId: string; payload: PagePayload; address: string }> {
  const address = `box-${randomUUID()}@import-errors.test`;
  const [row] = await getDb()
    .insert(connectedSource)
    .values({
      userId,
      type: 'imap',
      accountLabel: address,
      accountAddress: address,
      status: 'connected',
      consentTextVersion: 'v1',
    })
    .returning({ id: connectedSource.id });
  const sourceId = row!.id;
  const { id: importJobId } = await imports.createJob({ userId, sourceId, kind });
  return { sourceId, importJobId, payload: { userId, sourceId, importJobId }, address };
}

function mailbox(
  address: string,
  count: number,
  opts: { folderKey?: string; idPrefix?: string } = {},
): ScriptedFolder {
  const folderKey = opts.folderKey ?? 'INBOX';
  const idPrefix = opts.idPrefix ?? `${folderKey}-${randomUUID()}`;
  return {
    folderKey,
    name: folderKey,
    authored: folderKey === 'Sent',
    messages: Array.from({ length: count }, (_, i) =>
      rawMessage({ messageId: `${idPrefix}-${i}`, seq: i, to: address }),
    ),
  };
}

const jobRow = async (id: string) =>
  (await getDb().select().from(importJob).where(eq(importJob.id, id)))[0]!;
const sourceRow = async (id: string) =>
  (await getDb().select().from(connectedSource).where(eq(connectedSource.id, id)))[0]!;
const cursorRows = (sourceId: string) =>
  getDb()
    .select()
    .from(syncCursor)
    .where(eq(syncCursor.sourceId, sourceId))
    .orderBy(syncCursor.folderKey);
const countItems = async (userId: string) =>
  (
    (await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItem)
      .where(eq(contentItem.userId, userId))) as [{ n: number }]
  )[0].n;
const occurrences = (sourceId: string) =>
  getDb().select().from(contentItemOccurrence).where(eq(contentItemOccurrence.sourceId, sourceId));
const jobsOf = (sourceId: string) =>
  getDb().select().from(importJob).where(eq(importJob.sourceId, sourceId)).orderBy(importJob.id);

async function docIds(store: InMemoryMemoryStore, userId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const res = await store.listDocuments(namespaceFor(userId), { page, limit: 100 });
    ids.push(...res.documents.map((d) => d.id));
    if (!res.hasMore) break;
  }
  return ids;
}

/** Runs the source's queued pages until the job reaches a terminal outcome. */
async function drain(run: Runner, sourceId: string): Promise<Outcome> {
  let last: Outcome = { outcome: 'none' };
  for (let guard = 0; fifo.some((p) => p.sourceId === sourceId); guard++) {
    expect(guard).toBeLessThan(50);
    last = await run(takeFor(sourceId)).result;
  }
  return last;
}

beforeAll(async () => {
  await getPool().query('select 1');
});

afterEach(() => {
  inspectGate.wait = async () => undefined;
  fifo.length = 0;
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeQueues();
  await closeDb();
});

describe('import.page: mailbox authorization lost (MailAuthError)', () => {
  it('marks the source needs_reconnection, pauses the job for auth, notifies, and never retries', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId);
    const fetcher = scriptedFetcher([mailbox(src.address, 3)], 100);
    fetcher.listPageError = () => new MailAuthError();
    const run = runner(fetcher, new InMemoryMemoryStore());

    const { job, result } = run(src.payload);
    await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(result).rejects.toThrow('mail_auth');

    expect(await sourceRow(src.sourceId)).toMatchObject({
      status: 'needs_reconnection',
      lastErrorCode: 'mail_auth',
    });
    expect(await jobRow(src.importJobId)).toMatchObject({ status: 'paused', pauseReason: 'auth' });
    const notes = await getDb().select().from(notification).where(eq(notification.userId, userId));
    expect(notes.map((n) => ({ type: n.type, payload: n.payload }))).toEqual([
      { type: 'source_needs_reconnection', payload: { sourceId: src.sourceId } },
    ]);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(fifo.filter((p) => p.sourceId === src.sourceId)).toEqual([]);
    expect(await countItems(userId)).toBe(0);

    // The paused job is not runnable; a stale page is a no-op.
    expect((await run(src.payload).result).outcome).toBe('aborted');
  });

  it('treats an auth error returned per message by the fetcher as a page-level error', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId);
    const fetcher = scriptedFetcher([mailbox(src.address, 3)], 100);
    fetcher.fetchError = new MailAuthError();
    fetcher.fetchErrorAsValue = true;
    const run = runner(fetcher, new InMemoryMemoryStore());

    await expect(run(src.payload).result).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await sourceRow(src.sourceId)).status).toBe('needs_reconnection');
    expect((await jobRow(src.importJobId)).status).toBe('paused');
    expect(await countItems(userId)).toBe(0);
  });
});

describe('import.page: provider rate limit (RateLimitedError)', () => {
  it('re-delays the same job by retryAfterMs and changes no counts or checkpoint', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId);
    const fetcher = scriptedFetcher([mailbox(src.address, 3)], 100);
    fetcher.fetchError = new RateLimitedError(5_000);
    const run = runner(fetcher, new InMemoryMemoryStore());

    const before = Date.now();
    const { job, result } = run(src.payload);
    await expect(result).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [until, token] = job.moveToDelayed.mock.calls[0] as unknown as [number, string];
    expect(until).toBeGreaterThanOrEqual(before + 5_000);
    expect(until).toBeLessThan(before + 5_000 + 5_000);
    expect(token).toBe('token');

    const row = await jobRow(src.importJobId);
    expect(row).toMatchObject({
      status: 'running',
      itemsDiscovered: 0,
      itemsProcessed: 0,
      itemsImported: 0,
      itemsFailed: 0,
      errorCode: null,
    });
    expect((await sourceRow(src.sourceId)).status).toBe('connected');
    const cursors = await cursorRows(src.sourceId);
    expect(cursors).toHaveLength(1);
    expect(cursors[0]).toMatchObject({
      folderKey: 'INBOX',
      initialCheckpoint: null,
      cursor: null,
      initialComplete: false,
    });
    // No new page: the delayed job itself is the retry.
    expect(fifo.filter((p) => p.sourceId === src.sourceId)).toEqual([]);
    expect(await countItems(userId)).toBe(0);

    // Once the provider recovers, the delayed job imports the page as if nothing happened.
    fetcher.fetchError = undefined;
    expect(await run(src.payload).result).toMatchObject({ outcome: 'page_done', processed: 3 });
    expect((await drain(run, src.sourceId)).outcome).toBe('completed');
    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'completed',
      itemsImported: 3,
      itemsProcessed: 3,
    });
  });
});

describe('import.page: expired sync cursor (Gmail history 404 / Graph delta 410)', () => {
  it('fails the incremental job as cursor_expired, resets the folder and schedules a resync', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId, 'incremental');
    await imports.checkpoint(src.sourceId, 'INBOX', {
      initialCheckpoint: null,
      cursor: { historyId: '12345' },
      initialComplete: true,
    });
    const fetcher = scriptedFetcher([mailbox(src.address, 3)], 100);
    fetcher.listPageError = (_folder, mode) =>
      mode === 'incremental' ? new HistoryExpiredError() : undefined;
    const store = new InMemoryMemoryStore();
    const run = runner(fetcher, store);

    expect(await run(src.payload).result).toEqual({ outcome: 'resync_scheduled', processed: 0 });

    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'failed',
      errorCode: 'cursor_expired',
    });
    expect(fetcher.pages).toEqual([{ folderKey: 'INBOX', mode: 'incremental' }]);
    const [cursor] = await cursorRows(src.sourceId);
    expect(cursor).toMatchObject({ initialCheckpoint: null, cursor: null, initialComplete: false });

    const jobs = await jobsOf(src.sourceId);
    const resync = jobs.find((j) => j.kind === 'resync');
    expect(resync).toMatchObject({ status: 'queued', userId });
    expect(fifo.filter((p) => p.sourceId === src.sourceId)).toEqual([
      { userId, sourceId: src.sourceId, importJobId: resync!.id },
    ]);
    expect((await sourceRow(src.sourceId)).status).toBe('connected');

    // The resync re-enumerates the folder in `resync` mode and leaves a fresh cursor behind.
    expect((await drain(run, src.sourceId)).outcome).toBe('completed');
    expect(
      fetcher.pages.slice(1).every((p) => p.mode === 'resync' && p.folderKey === 'INBOX'),
    ).toBe(true);
    expect(await jobRow(resync!.id)).toMatchObject({ status: 'completed', itemsImported: 3 });
    const [after] = await cursorRows(src.sourceId);
    expect(after).toMatchObject({
      initialComplete: true,
      cursor: { uidValidity: '1', lastUid: 3 },
    });
    expect(await countItems(userId)).toBe(3);
    expect((await docIds(store, userId)).length).toBe(3);
  });
});

describe('import.page: IMAP UIDVALIDITY changed (UidValidityChangedError)', () => {
  it('resets only the affected folder and resyncs it, keeping the other folder cursor', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId, 'incremental');
    const inbox = mailbox(src.address, 2, { folderKey: 'INBOX' });
    const sent = mailbox(src.address, 2, { folderKey: 'Sent' });
    for (const f of ['INBOX', 'Sent']) {
      await imports.checkpoint(src.sourceId, f, {
        initialCheckpoint: null,
        cursor: { uidValidity: '1', lastUid: 2 },
        initialComplete: true,
      });
    }
    const fetcher = scriptedFetcher([inbox, sent], 100);
    // The IMAP client surfaces a changed UIDVALIDITY as a per-message value from fetchMessages too; the throwing
    // listPage variant is the one checked here.
    fetcher.listPageError = (folder, mode) =>
      mode === 'incremental' && folder.folderKey === 'INBOX'
        ? new UidValidityChangedError('INBOX')
        : undefined;
    const run = runner(fetcher, new InMemoryMemoryStore());

    expect(await run(src.payload).result).toEqual({ outcome: 'resync_scheduled', processed: 0 });

    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'failed',
      errorCode: 'cursor_expired',
    });
    const [inboxCursor, sentCursor] = await cursorRows(src.sourceId);
    expect(inboxCursor).toMatchObject({ folderKey: 'INBOX', cursor: null, initialComplete: false });
    expect(sentCursor).toMatchObject({
      folderKey: 'Sent',
      cursor: { uidValidity: '1', lastUid: 2 },
      initialComplete: true,
    });
    const resync = (await jobsOf(src.sourceId)).find((j) => j.kind === 'resync');
    expect(resync).toMatchObject({ status: 'queued' });

    fetcher.pages.length = 0;
    expect((await drain(run, src.sourceId)).outcome).toBe('completed');
    // Only INBOX is walked again; Sent (still initialComplete) is untouched by a resync.
    expect(fetcher.pages.every((p) => p.folderKey === 'INBOX' && p.mode === 'resync')).toBe(true);
    expect(fetcher.pages.length).toBeGreaterThan(0);
    expect(await jobRow(resync!.id)).toMatchObject({ status: 'completed', itemsImported: 2 });
    expect((await occurrences(src.sourceId)).every((o) => o.providerRef.startsWith('INBOX|'))).toBe(
      true,
    );
  });
});

describe('import.page: memory store failure', () => {
  it('rolls back the rows of the page, keeps the checkpoint, and the retry imports everything once', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId);
    const fetcher = scriptedFetcher([mailbox(src.address, 5)], 100);
    const store = new FlakyStore();
    store.down = true;
    const run = runner(fetcher, store);

    await expect(run(src.payload).result).rejects.toThrow('supermemory_unavailable');

    // Nothing half-written survives and the page is not counted as progress.
    expect(await countItems(userId)).toBe(0);
    expect(await occurrences(src.sourceId)).toEqual([]);
    expect(await docIds(store, userId)).toEqual([]);
    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'running',
      errorCode: null,
      itemsProcessed: 0,
      itemsImported: 0,
      itemsFailed: 0,
    });
    const [cursor] = await cursorRows(src.sourceId);
    expect(cursor).toMatchObject({ initialCheckpoint: null, initialComplete: false });
    // The BullMQ retry of the same job is the retry; no extra page was queued.
    expect(fifo.filter((p) => p.sourceId === src.sourceId)).toEqual([]);

    store.down = false;
    expect(await run(src.payload, 1).result).toMatchObject({ outcome: 'page_done', processed: 5 });
    expect((await drain(run, src.sourceId)).outcome).toBe('completed');
    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'completed',
      itemsImported: 5,
      itemsProcessed: 5,
      itemsDuplicate: 0,
    });
    expect(await countItems(userId)).toBe(5);
    expect((await occurrences(src.sourceId)).length).toBe(5);
    const ids = await docIds(store, userId);
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('fails the job as import_failed on the final attempt', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId);
    const fetcher = scriptedFetcher([mailbox(src.address, 2)], 100);
    const store = new FlakyStore();
    store.down = true;
    const run = runner(fetcher, store);

    await expect(run(src.payload, 4).result).rejects.toThrow('supermemory_unavailable');

    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'failed',
      errorCode: 'import_failed',
    });
    expect(await countItems(userId)).toBe(0);
    expect((await sourceRow(src.sourceId)).status).toBe('connected');
  });
});

describe('import.page: concurrent writers of one Message-ID', () => {
  it('retries the unique violation once and counts the loser as a duplicate', async () => {
    const { userId } = await newUser();
    const src = await newSource(userId);
    // Two refs on one page carrying the same Message-ID (e.g. the same mail in two folders).
    const shared = rawMessage({ messageId: `shared-${randomUUID()}`, seq: 1, to: src.address });
    const fetcher = scriptedFetcher(
      [{ folderKey: 'INBOX', name: 'INBOX', authored: false, messages: [shared, shared] }],
      100,
    );
    const store = new InMemoryMemoryStore();
    const run = runner(fetcher, store);
    // Both pass the dedup lookup as `new` before either writes.
    inspectGate.wait = barrier(2);

    expect(await run(src.payload).result).toMatchObject({ outcome: 'page_done', processed: 2 });

    expect(await countItems(userId)).toBe(1);
    const occ = await occurrences(src.sourceId);
    expect(occ.map((o) => o.providerRef).sort()).toEqual(['INBOX|1', 'INBOX|2']);
    expect(new Set(occ.map((o) => o.contentItemId)).size).toBe(1);
    expect(await jobRow(src.importJobId)).toMatchObject({
      itemsImported: 1,
      itemsDuplicate: 1,
      itemsProcessed: 2,
      itemsFailed: 0,
    });
    expect((await docIds(store, userId)).length).toBe(1);
    expect((await sourceRow(src.sourceId)).itemCount).toBe(2);
  });
});

describe('import.page: pause landing mid-page', () => {
  it('writes none of the remaining messages, keeps the page-boundary checkpoint, and resumes without duplicates', async () => {
    const { userId, ctx } = await newUser();
    const src = await newSource(userId);
    const fetcher = scriptedFetcher([mailbox(src.address, 7)], 3);
    const store = new InMemoryMemoryStore();
    const run = runner(fetcher, store);

    // Page 1 (UIDs 1-3) lands normally.
    expect(await run(src.payload).result).toMatchObject({ outcome: 'page_done', processed: 3 });
    expect(await jobRow(src.importJobId)).toMatchObject({ itemsProcessed: 3, itemsImported: 3 });
    const [checkpoint] = await cursorRows(src.sourceId);
    expect(checkpoint).toMatchObject({ initialCheckpoint: { uidNext: 4 }, initialComplete: false });

    // Page 2 (UIDs 4-6): the user pauses once every message is past its dedup lookup, before any write.
    inspectGate.wait = barrier(3, async () => {
      await sources.pause(ctx, src.sourceId);
    });
    expect(await run(takeFor(src.sourceId)).result).toEqual({ outcome: 'aborted', processed: 0 });

    expect(await countItems(userId)).toBe(3);
    expect((await occurrences(src.sourceId)).length).toBe(3);
    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      itemsProcessed: 3,
      itemsImported: 3,
    });
    expect((await sourceRow(src.sourceId)).status).toBe('paused');
    const [kept] = await cursorRows(src.sourceId);
    expect(kept).toMatchObject({ initialCheckpoint: { uidNext: 4 }, initialComplete: false });
    expect(fifo.filter((p) => p.sourceId === src.sourceId)).toEqual([]);

    inspectGate.wait = async () => undefined;
    await sources.resume(ctx, src.sourceId);
    expect((await drain(run, src.sourceId)).outcome).toBe('completed');

    expect(await jobRow(src.importJobId)).toMatchObject({
      status: 'completed',
      itemsProcessed: 7,
      itemsImported: 7,
      itemsDuplicate: 0,
    });
    expect(await countItems(userId)).toBe(7);
    const occ = await occurrences(src.sourceId);
    expect(new Set(occ.map((o) => o.providerRef)).size).toBe(7);
    const ids = await docIds(store, userId);
    expect(ids.length).toBe(7);
    expect(new Set(ids).size).toBe(7);
  });
});

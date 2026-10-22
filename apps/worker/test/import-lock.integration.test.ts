import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, connectedSource, getDb, getPool, importJob, user } from '@voicespark/db';
import { eq, inArray } from 'drizzle-orm';
import { jobIds, type JobPayload } from '@voicespark/core/queues';
import * as imports from '@voicespark/core/services/imports';
import { createRecordedClassifier } from '@voicespark/filters';
import type { FolderState, MailFetcher } from '@voicespark/integrations/mail';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import { createImportHandler, LOCKED_RETRY_DELAY_MS } from '../src/processors/import';

// Per-source lock hand-over (D-C6): the next page is enqueued only after the lock is released, and a page that finds
// the lock held is retried shortly instead of dropped. No BullMQ worker and no mail server: enqueue is captured and
// the fetcher is a stub. Needs Postgres and Redis.
type PagePayload = JobPayload<'import.page'>;
interface Enqueued {
  payload: PagePayload;
  delay: number | undefined;
  /** Whether the source lock was free at the moment of enqueueing. */
  lockFree: boolean;
}
const enqueued: Enqueued[] = [];

vi.mock('@voicespark/core/queues', async (importOriginal) => {
  const original = await importOriginal<typeof import('@voicespark/core/queues')>();
  return {
    ...original,
    enqueue: vi.fn(async (name: string, payload: unknown, opts?: { delay?: number }) => {
      if (name !== 'import.page') return {};
      const p = payload as PagePayload;
      const { acquireSourceLock } = await import('@voicespark/core/services/imports');
      const probe = await acquireSourceLock(p.sourceId);
      if (probe) await probe();
      enqueued.push({ payload: p, delay: opts?.delay, lockFree: probe !== null });
      return {};
    }),
  };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

/** One folder that never yields refs nor finishes: the run exhausts its list budget and hands over to a next page. */
function stubFetcher(): MailFetcher {
  return {
    provider: 'imap',
    getAddress: async () => 'lock@example.test',
    listFolders: async () => [{ folderKey: 'INBOX', name: 'INBOX', authored: false }],
    listPage: async (state: FolderState) => ({ refs: [], state, folderDone: false }),
    fetchMessages: async () => new Map(),
    close: async () => undefined,
  };
}

const handler = createImportHandler({
  store: new InMemoryMemoryStore(),
  classifier: createRecordedClassifier(),
  openFetcher: async () => stubFetcher(),
});

const run = (payload: PagePayload) =>
  handler(
    {
      id: jobIds.importPage(payload.sourceId, Date.now()),
      name: 'import.page',
      data: payload,
      attemptsMade: 0,
      opts: { attempts: 5 },
      moveToDelayed: vi.fn(async () => undefined),
    } as unknown as Job<PagePayload, unknown, 'import.page'>,
    'token',
  ) as Promise<{ outcome: string }>;

const userIds: string[] = [];

async function setup(): Promise<PagePayload> {
  const db = getDb();
  const [u] = await db
    .insert(user)
    .values({ name: 'Locker', email: `lock-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(u!.id);
  const [s] = await db
    .insert(connectedSource)
    .values({
      userId: u!.id,
      type: 'imap',
      accountLabel: 'lock',
      accountAddress: `lock-${randomUUID()}@example.test`,
      status: 'connected',
      consentTextVersion: 'v1',
    })
    .returning({ id: connectedSource.id });
  const [j] = await db
    .insert(importJob)
    .values({ userId: u!.id, sourceId: s!.id, kind: 'initial', status: 'queued' })
    .returning({ id: importJob.id });
  return { userId: u!.id, sourceId: s!.id, importJobId: j!.id };
}

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  enqueued.length = 0;
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('import.page source lock hand-over', () => {
  it('enqueues the next page only after releasing the source lock', async () => {
    const p = await setup();
    await expect(run(p)).resolves.toMatchObject({ outcome: 'page_done' });
    expect(enqueued).toEqual([{ payload: p, delay: undefined, lockFree: true }]);
  });

  it('re-enqueues a page that finds the lock held, with a short delay', async () => {
    const p = await setup();
    const release = await imports.acquireSourceLock(p.sourceId);
    expect(release).not.toBeNull();
    try {
      await expect(run(p)).resolves.toMatchObject({ outcome: 'locked' });
    } finally {
      await release!();
    }
    expect(enqueued.map((e) => [e.payload, e.delay])).toEqual([[p, LOCKED_RETRY_DELAY_MS]]);
  });

  it('drops a locked page whose job is no longer runnable (paused)', async () => {
    const p = await setup();
    await getDb().update(importJob).set({ status: 'paused' }).where(eq(importJob.id, p.importJobId));
    const release = await imports.acquireSourceLock(p.sourceId);
    try {
      await expect(run(p)).resolves.toMatchObject({ outcome: 'locked' });
    } finally {
      await release!();
    }
    expect(enqueued).toEqual([]);
  });
});

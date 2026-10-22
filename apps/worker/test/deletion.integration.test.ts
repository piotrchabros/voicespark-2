import { randomBytes, randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connectedSource,
  contentItem,
  contentItemOccurrence,
  getDb,
  getPool,
  importJob,
  user,
} from '@voicespark/db';
import { enqueue, jobIds, removeScheduler } from '@voicespark/core/queues';
import { getDeletion, requestDeletion } from '@voicespark/core/services/deletion';
import type { FilteredText } from '@voicespark/filters';
import { createMemoryStore, META, namespaceFor } from '@voicespark/integrations/supermemory';
import { handlers } from '../src/processors/deletion';

// Integration: compose Postgres (migrated) + the in-memory Supermemory store. Redis is not needed: enqueue is mocked.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  removeScheduler: vi.fn(async () => undefined),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');

const store = createMemoryStore({ NODE_ENV: 'test' });
const ft = (s: string) => s as FilteredText;
const execute = handlers['deletion.execute']!;

interface FakeJob {
  id: string;
  data: { deletionRequestId: string; waitCount?: number };
  opts: { attempts: number };
  attemptsMade: number;
  updateData: ReturnType<typeof vi.fn>;
  moveToDelayed: ReturnType<typeof vi.fn>;
}

function fakeJob(
  deletionRequestId: string,
  opts: { id?: string; waitCount?: number; attemptsMade?: number } = {},
): FakeJob {
  const job: FakeJob = {
    id: opts.id ?? jobIds.deletion(deletionRequestId),
    data: {
      deletionRequestId,
      ...(opts.waitCount !== undefined ? { waitCount: opts.waitCount } : {}),
    },
    opts: { attempts: 12 },
    attemptsMade: opts.attemptsMade ?? 0,
    updateData: vi.fn(async (d: FakeJob['data']) => {
      job.data = d;
    }),
    moveToDelayed: vi.fn(async () => undefined),
  };
  return job;
}

const run = (job: FakeJob) =>
  execute(job as unknown as Job<FakeJob['data'], unknown, 'deletion.execute'>, 'token');

const userIds: string[] = [];

async function createUser(): Promise<string> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Test', email: `deletion-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  return row!.id;
}

async function createSource(userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(connectedSource)
    .values({
      userId,
      type: 'imap',
      accountLabel: 'Test mailbox',
      accountAddress: `${randomUUID()}@example.test`,
      status: 'connected',
      consentTextVersion: 'v1',
    })
    .returning({ id: connectedSource.id });
  return row!.id;
}

async function createItem(userId: string, sourceIds: string[]): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(contentItem)
    .values({
      id,
      userId,
      kind: 'email',
      authorship: 'authored',
      itemDate: new Date(),
      wordCount: 3,
      contentHash: randomBytes(32).toString('hex'),
      filterPolicyVersion: 1,
      status: 'active',
    });
  for (const sourceId of sourceIds) {
    await getDb()
      .insert(contentItemOccurrence)
      .values({ contentItemId: id, sourceId, providerRef: randomUUID() });
  }
  await addDoc(userId, id, sourceIds);
  return id;
}

async function addDoc(userId: string, id: string, sourceIds: string[]): Promise<void> {
  await store.addDocuments(namespaceFor(userId), [
    {
      id,
      content: ft('hello from a test'),
      documentDate: new Date().toISOString(),
      metadata: { [META.contentItemId]: id, [META.sourceIds]: sourceIds },
    },
  ]);
}

const findItem = (id: string) =>
  getDb().query.contentItem.findFirst({ where: (t, { eq }) => eq(t.id, id) });
const findSource = (id: string) =>
  getDb().query.connectedSource.findFirst({ where: (t, { eq }) => eq(t.id, id) });

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
  vi.mocked(removeScheduler).mockClear();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getPool().query('delete from deletion_request where user_id = any($1::uuid[])', [
      userIds,
    ]);
    await getPool().query('delete from audit_log_entry where actor_user_id = any($1::uuid[])', [
      userIds,
    ]);
    await getPool().query('delete from "user" where id = any($1::uuid[])', [userIds]);
  }
  await closeDb();
});

describe('requestDeletion', () => {
  it('inserts a pending request due in 24 h and enqueues deletion-{id}', async () => {
    const userId = await createUser();
    const { id } = await requestDeletion({
      userId,
      scope: 'content_item',
      targetId: randomUUID(),
      requestedBy: 'user',
    });

    const row = await getDeletion(id);
    expect(row?.status).toBe('pending');
    expect(row?.subjectRef).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.dueBy.getTime() - row!.requestedAt.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId: id },
      { jobId: `deletion-${id}` },
    );
  });
});

describe('deletion.execute content_item', () => {
  it('deletes the document, verifies it is gone, then deletes the row; re-runs are no-ops', async () => {
    const userId = await createUser();
    const sourceId = await createSource(userId);
    const itemId = await createItem(userId, [sourceId]);
    const { id } = await requestDeletion({
      userId,
      scope: 'content_item',
      targetId: itemId,
      requestedBy: 'user',
    });

    await run(fakeJob(id));

    expect(await store.getDocument(namespaceFor(userId), itemId)).toBeNull();
    expect(await findItem(itemId)).toBeUndefined();
    const row = await getDeletion(id);
    expect(row?.status).toBe('completed');
    expect(row?.attempts).toBe(1);
    expect(row?.supermemoryDeletedCount).toBe(1);
    expect(row?.completedAt).toBeInstanceOf(Date);

    await run(fakeJob(id));
    expect((await getDeletion(id))?.attempts).toBe(1);
  });
});

describe('deletion.execute source', () => {
  it('deletes exclusive items, narrows shared ones, deletes the source and schedules the late-write sweep', async () => {
    const userId = await createUser();
    const ns = namespaceFor(userId);
    const src = await createSource(userId);
    const other = await createSource(userId);
    const exclusive = await createItem(userId, [src]);
    const shared = await createItem(userId, [src, other]);
    const untouched = await createItem(userId, [other]);
    const orphanDoc = randomUUID();
    await addDoc(userId, orphanDoc, [src]);

    const { id } = await requestDeletion({
      userId,
      scope: 'source',
      targetId: src,
      requestedBy: 'user',
    });
    await run(fakeJob(id));

    expect(await store.getDocument(ns, exclusive)).toBeNull();
    expect(await store.getDocument(ns, orphanDoc)).toBeNull();
    expect((await store.getDocument(ns, shared))?.metadata[META.sourceIds]).toEqual([other]);
    expect(await store.getDocument(ns, untouched)).not.toBeNull();
    const tagged = await store.listDocuments(ns, {
      filter: { field: META.sourceIds, operator: 'arrayContains', value: src },
      page: 1,
      limit: 10,
    });
    expect(tagged.documents).toHaveLength(0);

    expect(await findItem(exclusive)).toBeUndefined();
    expect(await findItem(shared)).toBeDefined();
    expect(await findSource(src)).toBeUndefined();
    expect(removeScheduler).toHaveBeenCalledWith('sync-poll', `poll-${src}`);

    const row = await getDeletion(id);
    expect(row?.status).toBe('completed');
    expect(row?.supermemoryDeletedCount).toBe(2);
    const audits = await getPool().query(
      `select metadata from audit_log_entry where action = 'source.deleted' and target_id = $1`,
      [src],
    );
    expect(audits.rows).toEqual([{ metadata: { deletedItems: 1, updatedItems: 1 } }]);
    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId: id },
      { jobId: `deletion-${id}-verify`, delay: 60_000 },
    );

    // A late write tagged with the deleted source is removed by the verify sweep; shared docs stay narrowed.
    const late = randomUUID();
    await addDoc(userId, late, [src]);
    vi.mocked(enqueue).mockClear();
    await run(fakeJob(id, { id: jobIds.deletionVerify(id) }));

    expect(await store.getDocument(ns, late)).toBeNull();
    expect(await store.getDocument(ns, shared)).not.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    const after = await getDeletion(id);
    expect(after?.status).toBe('completed');
    expect(after?.supermemoryDeletedCount).toBe(3);
  });

  it('waits for a running import by re-delaying the same job, then fails the attempt after 10 waits', async () => {
    const userId = await createUser();
    const src = await createSource(userId);
    await getDb()
      .insert(importJob)
      .values({ userId, sourceId: src, kind: 'initial', status: 'running' });
    const { id } = await requestDeletion({
      userId,
      scope: 'source',
      targetId: src,
      requestedBy: 'user',
    });

    const job = fakeJob(id);
    await expect(run(job)).rejects.toBeInstanceOf(DelayedError);
    expect(job.data.waitCount).toBe(1);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
    expect((await getDeletion(id))?.status).toBe('pending');

    await expect(run(fakeJob(id, { waitCount: 10 }))).rejects.toThrow('source_import_running');
    const row = await getDeletion(id);
    expect(row?.status).toBe('pending');
    expect(row?.lastErrorCode).toBe('source_import_running');
    expect(await findSource(src)).toBeDefined();
  });
});

describe('deletion.execute account scope', () => {
  // The account flow itself is covered by account-deletion.integration.test.ts.
  it('fails account requests without a target user as missing_target without retry', async () => {
    const userId = await createUser();
    const { id } = await requestDeletion({ userId, scope: 'account', requestedBy: 'user' });

    await expect(run(fakeJob(id))).rejects.toBeInstanceOf(UnrecoverableError);
    const row = await getDeletion(id);
    expect(row?.status).toBe('failed');
    expect(row?.lastErrorCode).toBe('missing_target');
  });
});

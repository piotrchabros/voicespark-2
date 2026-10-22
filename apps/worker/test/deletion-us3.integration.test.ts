import { randomBytes, randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connectedSource,
  contentItem,
  contentItemOccurrence,
  getDb,
  getPool,
  retroscan,
  user,
} from '@voicespark/db';
import { enqueue, jobIds } from '@voicespark/core/queues';
import * as contentItems from '@voicespark/core/services/content-items';
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
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const store = createMemoryStore({ NODE_ENV: 'test' });
const execute = handlers['deletion.execute']!;

const run = (deletionRequestId: string) =>
  execute(
    {
      id: jobIds.deletion(deletionRequestId),
      data: { deletionRequestId },
      opts: { attempts: 12 },
      attemptsMade: 0,
      updateData: vi.fn(),
      moveToDelayed: vi.fn(),
    } as unknown as Job<{ deletionRequestId: string }, unknown, 'deletion.execute'>,
    'token',
  );

const userIds: string[] = [];

async function createUser(): Promise<string> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Test', email: `deletion-us3-${randomUUID()}@example.test` })
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
      itemCount: 10,
    })
    .returning({ id: connectedSource.id });
  return row!.id;
}

async function createItem(
  userId: string,
  sourceId: string | null,
  opts: { parentItemId?: string; content?: string; itemDate?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(contentItem)
    .values({
      id,
      userId,
      kind: opts.parentItemId ? 'attachment' : 'email',
      parentItemId: opts.parentItemId ?? null,
      authorship: 'authored',
      itemDate: opts.itemDate ?? new Date(),
      wordCount: 3,
      contentHash: randomBytes(32).toString('hex'),
      filterPolicyVersion: 1,
      status: 'active',
    });
  if (sourceId) {
    await getDb()
      .insert(contentItemOccurrence)
      .values({ contentItemId: id, sourceId, providerRef: randomUUID() });
  }
  await store.addDocuments(namespaceFor(userId), [
    {
      id,
      content: (opts.content ??
        'Subject: Hello\nDate: 2026-01-01\n\nhello from a test') as FilteredText,
      documentDate: new Date().toISOString(),
      metadata: { [META.contentItemId]: id, [META.sourceIds]: sourceId ? [sourceId] : [] },
    },
  ]);
  return id;
}

const findItem = (id: string) =>
  getDb().query.contentItem.findFirst({ where: (t, { eq }) => eq(t.id, id) });
const findSource = (id: string) =>
  getDb().query.connectedSource.findFirst({ where: (t, { eq }) => eq(t.id, id) });
const purgedAudits = (targetId: string) =>
  getPool().query(
    `select actor_type, metadata from audit_log_entry where action = 'content.purged' and target_id = $1`,
    [targetId],
  );

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
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

describe('content items report -> deletion.execute exclusion_report', () => {
  it('records the report, purges the item and its attachment, marks the report purged and audits', async () => {
    const userId = await createUser();
    const ns = namespaceFor(userId);
    const src = await createSource(userId);
    const itemId = await createItem(userId, src);
    const attachmentId = await createItem(userId, null, { parentItemId: itemId });
    const ctx = { userId, role: 'user' as const };

    const { reportId, deletionRequestId } = await contentItems.report(ctx, itemId, 'health');
    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId },
      { jobId: `deletion-${deletionRequestId}` },
    );
    const submitted = await getPool().query(
      `select metadata from audit_log_entry where action = 'exclusion.report_submitted' and target_id = $1`,
      [reportId],
    );
    expect(submitted.rows).toEqual([{ metadata: { category: 'health' } }]);

    await run(deletionRequestId);

    expect(await store.getDocument(ns, itemId)).toBeNull();
    expect(await store.getDocument(ns, attachmentId)).toBeNull();
    expect(await findItem(itemId)).toBeUndefined();
    expect(await findItem(attachmentId)).toBeUndefined();
    expect((await findSource(src))?.itemCount).toBe(9);

    const reportRow = await getDb().query.exclusionReport.findFirst({
      where: (t, { eq }) => eq(t.id, reportId),
    });
    expect(reportRow?.status).toBe('purged');
    expect(reportRow?.purgedAt).toBeInstanceOf(Date);
    expect(reportRow?.contentItemId).toBeNull();
    expect(reportRow?.sourceId).toBe(src);

    const row = await getDeletion(deletionRequestId);
    expect(row?.scope).toBe('exclusion_report');
    expect(row?.status).toBe('completed');
    expect(row?.supermemoryDeletedCount).toBe(2);
    expect((await purgedAudits(reportId)).rows).toEqual([
      { actor_type: 'user', metadata: { scope: 'exclusion_report', count: 2 } },
    ]);
  });

  it("rejects reports for items that are not the caller's", async () => {
    const owner = await createUser();
    const other = await createUser();
    const itemId = await createItem(owner, await createSource(owner));
    await expect(
      contentItems.report({ userId: other, role: 'user' }, itemId),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      contentItems.report({ userId: other, role: 'user' }, 'nope'),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('deletion.execute retroscan_purge', () => {
  it('purges every matched item that still exists and completes the retroscan', async () => {
    const userId = await createUser();
    const ns = namespaceFor(userId);
    const src = await createSource(userId);
    const a = await createItem(userId, src);
    const b = await createItem(userId, src);
    const gone = randomUUID(); // already deleted before the purge ran
    const kept = await createItem(userId, src);

    const [scan] = await getDb()
      .insert(retroscan)
      .values({
        userId,
        trigger: 'rule_created',
        status: 'purging',
        matchedCount: 3,
        matchedItemIds: [a, b, gone],
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: retroscan.id });
    const { id } = await requestDeletion({
      userId,
      scope: 'retroscan_purge',
      targetId: scan!.id,
      requestedBy: 'user',
    });

    await run(id);

    expect(await store.getDocument(ns, a)).toBeNull();
    expect(await store.getDocument(ns, b)).toBeNull();
    expect(await store.getDocument(ns, kept)).not.toBeNull();
    expect(await findItem(a)).toBeUndefined();
    expect(await findItem(b)).toBeUndefined();
    expect(await findItem(kept)).toBeDefined();
    expect((await findSource(src))?.itemCount).toBe(8);

    const scanRow = await getDb().query.retroscan.findFirst({
      where: (t, { eq }) => eq(t.id, scan!.id),
    });
    expect(scanRow?.status).toBe('completed');
    const row = await getDeletion(id);
    expect(row?.status).toBe('completed');
    expect(row?.supermemoryDeletedCount).toBe(2);
    expect((await purgedAudits(scan!.id)).rows).toEqual([
      { actor_type: 'user', metadata: { scope: 'retroscan_purge', count: 2 } },
    ]);
  });
});

describe('content items list', () => {
  it('lists active items newest first with live title/snippet, a keyset cursor, source and query filters', async () => {
    const userId = await createUser();
    const ctx = { userId, role: 'user' as const };
    const src = await createSource(userId);
    const other = await createSource(userId);
    const older = await createItem(userId, src, {
      itemDate: new Date('2026-01-01T00:00:00Z'),
      content: 'Subject: Quarterly plan\nDate: 2026-01-01\n\nWe ship the roadmap next week.',
    });
    const newer = await createItem(userId, other, {
      itemDate: new Date('2026-02-01T00:00:00Z'),
      content: 'Title: notes.txt\n\nGardening tips for spring.',
    });

    const first = await contentItems.list(ctx, { limit: 1 }, store);
    expect(first.items).toEqual([
      {
        id: newer,
        kind: 'email',
        authorship: 'authored',
        itemDate: '2026-02-01T00:00:00.000Z',
        sourceIds: [other],
        title: 'notes.txt',
        snippet: 'Gardening tips for spring.',
      },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await contentItems.list(ctx, { limit: 1, cursor: first.nextCursor! }, store);
    expect(second.items.map((i) => i.id)).toEqual([older]);
    expect(second.items[0]?.title).toBe('Quarterly plan');
    expect(second.nextCursor).toBeNull();

    const bySource = await contentItems.list(ctx, { limit: 10, sourceId: src }, store);
    expect(bySource.items.map((i) => i.id)).toEqual([older]);

    const searched = await contentItems.list(ctx, { limit: 10, query: 'roadmap' }, store);
    expect(searched.items.map((i) => i.id)).toEqual([older]);

    const stranger = await contentItems.list(
      { userId: await createUser(), role: 'user' },
      { limit: 10 },
      store,
    );
    expect(stranger.items).toEqual([]);
  });
});

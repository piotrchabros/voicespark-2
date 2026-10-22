import { randomBytes, randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { QUEUES, enqueue, jobIds, upsertScheduler } from '@voicespark/core/queues';
import { getDeletion } from '@voicespark/core/services/deletion';
import type { FilteredText } from '@voicespark/filters';
import { createMemoryStore, META, namespaceFor } from '@voicespark/integrations/supermemory';
import { handlers as deletionHandlers } from '../src/processors/deletion';
import { handlers } from '../src/processors/maintenance';

// maintenance.credential-audit (T167, SC-005; D-T2: needs Postgres, so an integration test): samples each active
// namespace, runs only the locked detectors and requests deletion of any document holding a credential; the
// following deletion.execute purges it. Also checks the weekly scheduler registration in src/index.ts.
// Postgres + the shared in-memory Supermemory store; queues and the BullMQ Worker mocked (no Redis needed).
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
  getRedisConnection: vi.fn(() => ({})),
  closeQueues: vi.fn(async () => undefined),
}));

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  class FakeWorker {
    on() {
      return this;
    }
    async waitUntilReady() {
      return undefined;
    }
    async close() {
      return undefined;
    }
  }
  return { ...actual, Worker: FakeWorker };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const PASSWORD = 'Hunter2xyz!';
const PASSWORD_DOC = `Quick note before the trip.\nLogin details\npassword: ${PASSWORD}\nThanks, Ada`;
const BENIGN_DOC = 'We ship the roadmap next week and keep things simple. Cheers, Ada';

// Same singleton the processors resolve through createMemoryStore(loadEnv()) under NODE_ENV=test.
const store = createMemoryStore({ NODE_ENV: 'test' });

const audit = handlers['maintenance.credential-audit']!;
const execute = deletionHandlers['deletion.execute']!;

const runAudit = () =>
  audit(
    {
      id: 'maintenance.credential-audit',
      name: 'maintenance.credential-audit',
      data: {},
      attemptsMade: 0,
      opts: { attempts: 1 },
    } as unknown as Job<Record<string, never>, unknown, 'maintenance.credential-audit'>,
    'token',
  ) as Promise<{ namespaces: number; scanned: number; hits: number; deletionRequests: number }>;

const runDeletion = (deletionRequestId: string) =>
  execute(
    {
      id: jobIds.deletion(deletionRequestId),
      name: 'deletion.execute',
      data: { deletionRequestId },
      opts: { attempts: 12 },
      attemptsMade: 0,
      updateData: vi.fn(),
      moveToDelayed: vi.fn(),
    } as unknown as Job<{ deletionRequestId: string }, unknown, 'deletion.execute'>,
    'token',
  );

const userIds: string[] = [];

async function createUser(status: 'active' | 'suspended' = 'active'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into "user" (name, email, status) values ('Ada Lovelace', $1, $2) returning id`,
    [`credential-audit-${randomUUID()}@example.test`, status],
  );
  userIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function createSource(userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into connected_source (user_id, type, account_label, status, consent_text_version)
     values ($1, 'uploads', 'Uploads', 'connected', 'v1') returning id`,
    [userId],
  );
  return rows[0]!.id;
}

/** An active content item with its document (content cast to FilteredText as if stored under older rules). */
async function createItem(
  userId: string,
  sourceId: string,
  text: string,
  parentItemId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    `insert into content_item (id, user_id, kind, authorship, item_date, word_count, content_hash, filter_policy_version,
       status, parent_item_id)
     values ($1, $2, $3, 'authored', now(), 10, $4, 1, 'active', $5)`,
    [
      id,
      userId,
      parentItemId ? 'attachment' : 'email',
      randomBytes(32).toString('hex'),
      parentItemId,
    ],
  );
  await getPool().query(
    'insert into content_item_occurrence (content_item_id, source_id, provider_ref) values ($1, $2, $3)',
    [id, sourceId, randomUUID()],
  );
  await store.addDocuments(namespaceFor(userId), [
    {
      id,
      content: text as FilteredText,
      documentDate: new Date().toISOString(),
      metadata: {
        [META.contentItemId]: id,
        [META.sourceIds]: [sourceId],
        ...(parentItemId ? { [META.parentItemId]: parentItemId } : {}),
      },
    },
  ]);
  return id;
}

const systemRequests = async (userId: string) =>
  (
    await getPool().query<{ id: string; target_id: string }>(
      `select id, target_id from deletion_request
       where user_id = $1 and scope = 'content_item' and requested_by = 'system'`,
      [userId],
    )
  ).rows;

/** Every document left in the user's namespace, with its content. */
async function namespaceContents(userId: string): Promise<{ id: string; content: string }[]> {
  const ns = namespaceFor(userId);
  const out: { id: string; content: string }[] = [];
  for (let page = 1; ; page++) {
    const { documents, hasMore } = await store.listDocuments(ns, { page, limit: 100 });
    for (const d of documents) {
      const doc = await store.getDocument(ns, d.id);
      if (doc) out.push({ id: doc.id, content: doc.content });
    }
    if (!hasMore) break;
  }
  return out;
}

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
    await getPool().query(
      `delete from audit_log_entry where target_type = 'user' and target_id = any($1::text[])`,
      [userIds],
    );
    await getPool().query('delete from "user" where id = any($1::uuid[])', [userIds]);
  }
  await closeDb();
});

describe('maintenance.credential-audit', () => {
  it('finds a stored password, requests deletion of its parent item, and the deletion purges it', async () => {
    const userId = await createUser();
    const sourceId = await createSource(userId);
    const parent = await createItem(userId, sourceId, BENIGN_DOC);
    const child = await createItem(userId, sourceId, PASSWORD_DOC, parent);
    const kept = await createItem(userId, sourceId, BENIGN_DOC);

    const result = await runAudit();

    expect(result.hits).toBeGreaterThanOrEqual(1);
    expect(result.deletionRequests).toBeGreaterThanOrEqual(1);
    const requests = await systemRequests(userId);
    // The attachment's hit maps to its parent item (the deletion removes both).
    expect(requests).toEqual([{ id: expect.any(String), target_id: parent }]);
    const requestId = requests[0]!.id;
    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId: requestId },
      { jobId: `deletion-${requestId}` },
    );

    // One audit per user per category: counts only, never the value.
    const hits = await getPool().query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_log_entry where action = 'filter.audit_hit' and target_type = 'user' and target_id = $1`,
      [userId],
    );
    expect(hits.rows).toEqual([{ metadata: { category: 'passwords', count: 1 } }]);
    expect(JSON.stringify(hits.rows)).not.toContain(PASSWORD);

    // T167 acceptance: running the requested deletion leaves no password in the namespace.
    await runDeletion(requestId);

    expect((await getDeletion(requestId))?.status).toBe('completed');
    const left = await namespaceContents(userId);
    expect(left.map((d) => d.id)).toEqual([kept]);
    expect(left.some((d) => d.content.includes(PASSWORD))).toBe(false);
    expect(await store.getDocument(namespaceFor(userId), child)).toBeNull();

    // A later audit finds nothing more for this user.
    await runAudit();
    expect(await systemRequests(userId)).toHaveLength(1);
  });

  it('skips users who are not active', async () => {
    const userId = await createUser('suspended');
    const sourceId = await createSource(userId);
    await createItem(userId, sourceId, PASSWORD_DOC);

    await runAudit();

    expect(await systemRequests(userId)).toEqual([]);
  });

  it('reports nothing for benign documents', async () => {
    const userId = await createUser();
    const sourceId = await createSource(userId);
    await createItem(userId, sourceId, BENIGN_DOC);

    await runAudit();

    expect(await systemRequests(userId)).toEqual([]);
    const hits = await getPool().query(
      `select 1 from audit_log_entry where action = 'filter.audit_hit' and target_id = $1`,
      [userId],
    );
    expect(hits.rowCount).toBe(0);
  });
});

describe('worker schedulers', () => {
  it('registers the weekly credential audit next to the 15-minute deletion SLA', async () => {
    // Importing the entry point runs main(): Worker and queues are mocked; exit and signal handlers are contained.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const signals = ['SIGTERM', 'SIGINT'] as const;
    const before = new Map(signals.map((s) => [s, process.listeners(s)]));
    try {
      await import('../src/index');
      await vi.waitFor(
        () =>
          expect(upsertScheduler).toHaveBeenCalledWith(
            QUEUES.maintenance,
            'maintenance.deletion-sla',
            { every: 900_000 },
            { name: 'maintenance.deletion-sla', data: {} },
          ),
        { timeout: 5000 },
      );
      await vi.waitFor(
        () =>
          expect(upsertScheduler).toHaveBeenCalledWith(
            QUEUES.maintenance,
            'maintenance.credential-audit',
            { pattern: '0 4 * * 0' },
            { name: 'maintenance.credential-audit', data: {} },
          ),
        { timeout: 2000 },
      );
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      for (const s of signals) {
        for (const l of process.listeners(s)) {
          if (!before.get(s)!.includes(l)) process.removeListener(s, l);
        }
      }
    }
  }, 15_000);
});

import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool, type DeletionStatus } from '@voicespark/db';
import { subjectRef } from '@voicespark/core/crypto';
import { enqueue } from '@voicespark/core/queues';
import { getDeletion } from '@voicespark/core/services/deletion';
import { handlers } from '../src/processors/maintenance';

// maintenance.deletion-sla (T143, research R19, D-U7d/e/f): every 15 min flag non-completed requests that are
// overdue or due within 2 h, re-enqueue failed ones under a fresh job id, audit when anything is flagged.
// Postgres only; queues mocked (no Redis needed).
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

const HOUR = 3_600_000;
const sla = handlers['maintenance.deletion-sla']!;

const run = () =>
  sla(
    {
      id: 'maintenance.deletion-sla',
      name: 'maintenance.deletion-sla',
      data: {},
      attemptsMade: 0,
      opts: { attempts: 1 },
    } as unknown as Job<Record<string, never>, unknown, 'maintenance.deletion-sla'>,
    'token',
  ) as Promise<{ flagged: number; overdue: number; requeued: number }>;

const userIds: string[] = [];
const requestIds: string[] = [];

async function createUser(): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into "user" (name, email) values ('Sla Test', $1) returning id`,
    [`deletion-sla-${randomUUID()}@example.test`],
  );
  userIds.push(rows[0]!.id);
  return rows[0]!.id;
}

/** A content_item request with a chosen status and due_by offset from now. */
async function insertRequest(
  userId: string,
  status: DeletionStatus,
  dueInMs: number,
  attempts = 0,
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into deletion_request (user_id, subject_ref, scope, target_id, status, requested_by, requested_at, due_by,
       attempts, last_error_code, completed_at)
     values ($1, $2, 'content_item', $3, $4, 'user', now() - interval '20 hours', now() + ($5 || ' milliseconds')::interval,
       $6, $7, $8)
     returning id`,
    [
      userId,
      subjectRef(userId),
      randomUUID(),
      status,
      String(dueInMs),
      attempts,
      status === 'failed' ? 'verify_failed' : null,
      status === 'completed' ? new Date() : null,
    ],
  );
  requestIds.push(rows[0]!.id);
  return rows[0]!.id;
}

const slaAudits = async (since: Date) =>
  (
    await getPool().query<{ metadata: Record<string, unknown>; actor_type: string }>(
      `select metadata, actor_type from audit_log_entry where action = 'deletion.sla_flagged' and occurred_at >= $1`,
      [since],
    )
  ).rows;

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  if (requestIds.length > 0) {
    await getPool().query('delete from deletion_request where id = any($1::uuid[])', [requestIds]);
  }
  if (userIds.length > 0) {
    await getPool().query('delete from "user" where id = any($1::uuid[])', [userIds]);
  }
  await closeDb();
});

describe('maintenance.deletion-sla', () => {
  it('flags at-risk and overdue requests, re-enqueues failed ones and audits the counts', async () => {
    const userId = await createUser();
    const atRisk = await insertRequest(userId, 'pending', HOUR);
    const overdue = await insertRequest(userId, 'in_progress', -HOUR, 2);
    const failed = await insertRequest(userId, 'failed', 30 * 60_000, 4);
    const done = await insertRequest(userId, 'completed', -2 * HOUR, 1);
    const later = await insertRequest(userId, 'pending', 10 * HOUR);
    const started = new Date(Date.now() - 1000);

    const result = await run();

    // Other suites may leave rows behind in the shared test DB: ours are a lower bound.
    expect(result.flagged).toBeGreaterThanOrEqual(3);
    expect(result.overdue).toBeGreaterThanOrEqual(1);
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    // Failed rows go back to pending (error code kept) under a fresh retry job id (D-U7d).
    const retried = await getDeletion(failed);
    expect(retried?.status).toBe('pending');
    expect(retried?.lastErrorCode).toBe('verify_failed');
    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId: failed },
      { jobId: `deletion-${failed}-r4` },
    );
    const enqueuedIds = vi
      .mocked(enqueue)
      .mock.calls.map((c) => (c[1] as { deletionRequestId?: string }).deletionRequestId);
    for (const id of [atRisk, overdue, done, later]) expect(enqueuedIds).not.toContain(id);

    // Untouched rows keep their status.
    expect((await getDeletion(atRisk))?.status).toBe('pending');
    expect((await getDeletion(overdue))?.status).toBe('in_progress');
    expect((await getDeletion(done))?.status).toBe('completed');

    const audits = await slaAudits(started);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const mine = audits.find(
      (a) =>
        a.metadata.flagged === result.flagged &&
        a.metadata.overdue === result.overdue &&
        a.metadata.requeued === result.requeued,
    );
    expect(mine).toBeDefined();
    expect(mine!.actor_type).toBe('system');
    expect(Object.keys(mine!.metadata).sort()).toEqual(['flagged', 'overdue', 'requeued']);
  });

  it('does not re-enqueue a request it already reset to pending', async () => {
    const userId = await createUser();
    const failed = await insertRequest(userId, 'failed', HOUR, 1);

    await run();
    vi.mocked(enqueue).mockClear();
    await run();

    const enqueuedIds = vi
      .mocked(enqueue)
      .mock.calls.map((c) => (c[1] as { deletionRequestId?: string }).deletionRequestId);
    expect(enqueuedIds).not.toContain(failed);
    expect((await getDeletion(failed))?.status).toBe('pending');
  });
});

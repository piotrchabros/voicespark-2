import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  closeDb,
  connectedSource,
  filterPreferences,
  FILTER_CATEGORIES,
  getDb,
  getPool,
  importJob,
  syncCursor,
  user,
} from '@voicespark/db';
import { enqueue } from '@voicespark/core/queues';
import { handlers } from '../src/processors/sync-poll';
import { handlers as maintenance } from '../src/processors/maintenance';

// Integration: compose Postgres (migrated). Queues are mocked (no Redis needed).
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

const poll = handlers['sync.poll']!;
let userId: string;

const runPoll = (sourceId: string) =>
  poll({ id: `poll-${sourceId}`, data: { userId, sourceId } } as unknown as Job<
    { userId: string; sourceId: string },
    unknown,
    'sync.poll'
  >) as Promise<{ outcome: string; importJobId?: string }>;

const runMaintenance = (name: 'maintenance.stale-imports') =>
  maintenance[name]!({} as unknown as Job<Record<string, never>, unknown, typeof name>) as Promise<{
    count: number;
  }>;

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function createSource(
  opts: { status?: 'connected' | 'paused'; dateRangeTo?: string } = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(connectedSource)
    .values({
      userId,
      type: 'imap',
      accountLabel: 'Test mailbox',
      accountAddress: `${randomUUID()}@example.test`,
      status: opts.status ?? 'connected',
      consentTextVersion: 'v1',
      ...(opts.dateRangeTo ? { dateRangeTo: opts.dateRangeTo } : {}),
    })
    .returning({ id: connectedSource.id });
  return row!.id;
}

async function createJob(
  sourceId: string,
  status: 'running' | 'completed' | 'paused',
  times: { startedAt?: Date | null; lastActivityAt?: Date | null } = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(importJob)
    .values({
      userId,
      sourceId,
      kind: 'initial',
      status,
      startedAt: times.startedAt ?? null,
      lastActivityAt: times.lastActivityAt ?? null,
    })
    .returning({ id: importJob.id });
  return row!.id;
}

const jobsOf = (sourceId: string) =>
  getDb().select().from(importJob).where(eq(importJob.sourceId, sourceId));
const pageEnqueues = () =>
  vi
    .mocked(enqueue)
    .mock.calls.filter((c) => c[0] === 'import.page')
    .map((c) => c[1] as { userId: string; sourceId: string; importJobId: string });

beforeAll(async () => {
  await getPool().query('select 1');
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Poll', email: `sync-poll-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userId = row!.id;
  await getDb()
    .insert(filterPreferences)
    .values({
      userId,
      selectedCategories: [...FILTER_CATEGORIES],
      confirmedAt: new Date(),
      version: 3,
    });
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await getPool().query('delete from "user" where id = $1', [userId]);
  await closeDb();
});

describe('sync.poll', () => {
  it('skips a source that is not connected', async () => {
    const sourceId = await createSource({ status: 'paused' });
    expect(await runPoll(sourceId)).toEqual({ outcome: 'not_connected' });
    expect(await jobsOf(sourceId)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips when a non-terminal job exists', async () => {
    const sourceId = await createSource();
    await createJob(sourceId, 'running', { startedAt: new Date(), lastActivityAt: new Date() });
    expect(await runPoll(sourceId)).toEqual({ outcome: 'job_in_progress' });
    expect(await jobsOf(sourceId)).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips a closed date range in the past (range complete)', async () => {
    const sourceId = await createSource({ dateRangeTo: isoDay(-2) });
    expect(await runPoll(sourceId)).toEqual({ outcome: 'range_complete' });
    expect(await jobsOf(sourceId)).toHaveLength(0);
  });

  it('creates an incremental job pinned to the policy version and enqueues import.page', async () => {
    const sourceId = await createSource({ dateRangeTo: isoDay(0) });
    await createJob(sourceId, 'completed');
    await getDb()
      .insert(syncCursor)
      .values({
        sourceId,
        folderKey: 'INBOX',
        initialComplete: true,
        cursor: { uidValidity: '1', lastUid: 5 },
      });
    const result = await runPoll(sourceId);
    expect(result.outcome).toBe('incremental');
    const [job] = await getDb()
      .select()
      .from(importJob)
      .where(and(eq(importJob.sourceId, sourceId), eq(importJob.status, 'queued')));
    expect(job).toMatchObject({
      id: result.importJobId,
      kind: 'incremental',
      filterPolicyVersion: 3,
    });
    expect(pageEnqueues()).toEqual([{ userId, sourceId, importJobId: result.importJobId }]);
  });

  it('creates a resync job and resets the folders whose cursor expired', async () => {
    const sourceId = await createSource();
    await getDb()
      .insert(syncCursor)
      .values([
        {
          sourceId,
          folderKey: 'INBOX',
          initialComplete: true,
          cursor: { uidValidity: '1', lastUid: 5 },
        },
        {
          sourceId,
          folderKey: 'Sent',
          initialComplete: true,
          cursor: null,
          initialCheckpoint: { uidNext: 9 },
        },
      ]);
    const result = await runPoll(sourceId);
    expect(result.outcome).toBe('resync');
    const [job] = await jobsOf(sourceId);
    expect(job).toMatchObject({ kind: 'resync', status: 'queued' });
    const cursors = await getDb()
      .select()
      .from(syncCursor)
      .where(eq(syncCursor.sourceId, sourceId));
    const byKey = Object.fromEntries(cursors.map((c) => [c.folderKey, c]));
    expect(byKey.INBOX).toMatchObject({
      initialComplete: true,
      cursor: { uidValidity: '1', lastUid: 5 },
    });
    expect(byKey.Sent).toMatchObject({
      initialComplete: false,
      cursor: null,
      initialCheckpoint: null,
    });
    expect(pageEnqueues()).toHaveLength(1);
  });
});

describe('maintenance.stale-imports', () => {
  it('re-enqueues stalled running jobs on connected sources only', async () => {
    const old = new Date(Date.now() - 20 * 60_000);
    const stale = await createSource();
    const staleJob = await createJob(stale, 'running', { startedAt: old, lastActivityAt: old });
    const neverActive = await createSource();
    const neverActiveJob = await createJob(neverActive, 'running', {
      startedAt: old,
      lastActivityAt: null,
    });
    const fresh = await createSource();
    const freshJob = await createJob(fresh, 'running', {
      startedAt: old,
      lastActivityAt: new Date(),
    });
    const paused = await createSource({ status: 'paused' });
    const pausedJob = await createJob(paused, 'running', { startedAt: old, lastActivityAt: old });

    const { count } = await runMaintenance('maintenance.stale-imports');
    const enqueued = pageEnqueues();
    const jobIds = enqueued.map((p) => p.importJobId);
    expect(jobIds).toEqual(expect.arrayContaining([staleJob, neverActiveJob]));
    expect(jobIds).not.toContain(freshJob);
    expect(jobIds).not.toContain(pausedJob);
    expect(enqueued).toContainEqual({ userId, sourceId: stale, importJobId: staleJob });
    expect(count).toBe(enqueued.length);
  });
});

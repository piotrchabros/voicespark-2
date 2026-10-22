import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, FILTER_CATEGORIES, getDb, getPool, importJob, upload, user } from '@voicespark/db';
import { eq, inArray } from 'drizzle-orm';
import { resetEnvForTests } from '@voicespark/core/env';
import type { ServiceContext } from '@voicespark/core/errors';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import * as uploads from '@voicespark/core/services/uploads';
import { tmpSweep } from '../src/processors/maintenance';

// maintenance.tmp-sweep (T111, research R11): staged files older than 24 h are deleted and their uploads failed.
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
// Must be set before the first loadEnv() call.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'vs-up-'));
process.env.UPLOAD_TMP_DIR = TMP_DIR;
resetEnvForTests();

const PROSE = 'A quiet afternoon spent writing about gardens and the slow turning of seasons.';
const DAY_MS = 24 * 3600 * 1000;

const userIds: string[] = [];

async function createUser(): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Sweeper', email: `tmp-sweep-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  const ctx: ServiceContext = { userId: row!.id, role: 'user' };
  await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);
  return ctx;
}

async function findUpload(id: string) {
  const [row] = await getDb().select().from(upload).where(eq(upload.id, id));
  return row!;
}

async function findJob(id: string) {
  const [row] = await getDb().select().from(importJob).where(eq(importJob.id, id));
  return row!;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  await getPool().query('select 1');
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('maintenance.tmp-sweep', () => {
  it('deletes a staged file older than 24 h, fails its processing upload and job, and leaves fresh files alone', async () => {
    const ctx = await createUser();
    const old = await uploads.createFileUpload(ctx, { buffer: Buffer.from(PROSE), filename: 'old.txt' });
    const fresh = await uploads.createFileUpload(ctx, { buffer: Buffer.from(`${PROSE} fresh`), filename: 'fresh.txt' });

    await getDb().update(upload).set({ status: 'processing' }).where(eq(upload.id, old.uploadId));
    const oldRow = await findUpload(old.uploadId);
    const freshRow = await findUpload(fresh.uploadId);
    const past = new Date(Date.now() - DAY_MS - 3600 * 1000);
    await utimes(oldRow.stagingPath!, past, past);

    const result = await tmpSweep();
    // deletedFiles is scoped to this file's temp dir; failedUploads also counts stale rows of other users.
    expect(result.deletedFiles).toBe(1);
    expect(result.failedUploads).toBeGreaterThanOrEqual(1);

    expect(await exists(oldRow.stagingPath!)).toBe(false);
    const swept = await findUpload(old.uploadId);
    expect(swept.status).toBe('failed');
    expect(swept.stagingPath).toBeNull();
    expect((await findJob(oldRow.importJobId!)).status).toBe('failed');

    expect(await exists(freshRow.stagingPath!)).toBe(true);
    const kept = await findUpload(fresh.uploadId);
    expect(kept.status).toBe('received');
    expect(kept.stagingPath).toBe(freshRow.stagingPath);
    expect((await findJob(freshRow.importJobId!)).status).toBe('queued');
  });

  it('returns zero counts when UPLOAD_TMP_DIR does not exist', async () => {
    process.env.UPLOAD_TMP_DIR = join(tmpdir(), `vs-missing-${randomUUID()}`);
    resetEnvForTests();
    try {
      expect(await tmpSweep()).toMatchObject({ deletedFiles: 0 });
    } finally {
      process.env.UPLOAD_TMP_DIR = TMP_DIR;
      resetEnvForTests();
    }
  });
});

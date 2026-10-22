import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connectedSource,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  importJob,
  oauthConnectState,
  upload,
  user,
} from '@voicespark/db';
import { eq, inArray } from 'drizzle-orm';
import { enqueue } from '@voicespark/core/queues';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import * as sources from '@voicespark/core/services/sources';
import * as imports from '@voicespark/core/services/imports';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import { configureMailAccess } from '@voicespark/core/services/mail-access';
import * as uploads from '@voicespark/core/services/uploads';

// SC-014 / FR-061: nothing may start before the user confirms filter preferences. Queues are mocked.
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
process.env.GOOGLE_MAIL_CLIENT_ID ??= 'test-client';
process.env.GOOGLE_MAIL_CLIENT_SECRET ??= 'test-secret';
process.env.APP_URL ??= 'http://localhost:3000';
// Fresh staging dir, set before the first loadEnv() call.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'vs-up-'));
process.env.UPLOAD_TMP_DIR = TMP_DIR;

const imapCfg = () => ({
  host: process.env.GREENMAIL_HOST ?? 'localhost',
  port: 3993,
  tlsMode: 'tls' as const,
  username: `gate-${randomUUID()}@greenmail.test`,
  password: 'password',
});

const userIds: string[] = [];

async function createUser(confirmedAtNull: 'no_row' | 'null_row'): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Gate', email: `gate-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  if (confirmedAtNull === 'null_row') {
    await getDb()
      .insert(filterPreferences)
      .values({ userId: row!.id, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: null });
  }
  return { userId: row!.id, role: 'user' };
}

async function insertSource(userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(connectedSource)
    .values({
      userId,
      type: 'imap',
      accountLabel: 'Gate mailbox',
      accountAddress: `${randomUUID()}@example.test`,
      status: 'connected',
      consentTextVersion: 'v1',
    })
    .returning({ id: connectedSource.id });
  return row!.id;
}

async function counts(userId: string, insertedSourceId: string) {
  const db = getDb();
  const srcs = await db.select({ id: connectedSource.id }).from(connectedSource).where(eq(connectedSource.userId, userId));
  const jobs = await db.select({ id: importJob.id }).from(importJob).where(eq(importJob.userId, userId));
  const states = await db.select({ id: oauthConnectState.id }).from(oauthConnectState).where(eq(oauthConnectState.userId, userId));
  return {
    otherSources: srcs.filter((s) => s.id !== insertedSourceId).length,
    jobs: jobs.length,
    states: states.length,
  };
}

async function expectGated(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe('filter_confirmation_required');
  expect((err as AppError).status).toBe(409);
}

beforeAll(async () => {
  await getPool().query('select 1');
  configureMailAccess({ imap: { rejectUnauthorized: false } });
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe.each([
  ['no filter_preferences row', 'no_row'],
  ['confirmed_at null', 'null_row'],
] as const)('first-import gate (%s)', (_label, variant) => {
  it('rejects every start path with filter_confirmation_required and writes nothing', async () => {
    const ctx = await createUser(variant);
    const sourceId = await insertSource(ctx.userId);

    await expectGated(sources.startConnect(ctx, 'gmail'));
    await expectGated(sources.connectImap(ctx, imapCfg()));
    await expectGated(imports.createJob({ userId: ctx.userId, sourceId, kind: 'initial' }));

    expect(await counts(ctx.userId, sourceId)).toEqual({ otherSources: 0, jobs: 0, states: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('succeeds after the preferences are confirmed', async () => {
    const ctx = await createUser(variant);
    const sourceId = await insertSource(ctx.userId);
    await expectGated(sources.startConnect(ctx, 'gmail'));

    await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);

    const start = await sources.startConnect(ctx, 'gmail');
    const state = new URL(start.authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(start.authorizeUrl).toContain(state!);

    const view = await sources.connectImap(ctx, imapCfg());
    expect(view.type).toBe('imap');

    const job = await imports.createJob({ userId: ctx.userId, sourceId, kind: 'initial' });
    expect(job.id).toBeTruthy();
    expect(enqueue).toHaveBeenCalled();
  });

  it('rejects uploads and notes before any I/O, then accepts them after confirmation (T109)', async () => {
    const ctx = await createUser(variant);
    const text = 'A short reflection on the garden in early spring.';
    const uploadRows = () => getDb().select({ id: upload.id }).from(upload).where(eq(upload.userId, ctx.userId));
    const jobRows = () => getDb().select({ id: importJob.id }).from(importJob).where(eq(importJob.userId, ctx.userId));
    const sourceRows = () =>
      getDb().select({ id: connectedSource.id }).from(connectedSource).where(eq(connectedSource.userId, ctx.userId));
    const filesBefore = await readdir(TMP_DIR);

    await expectGated(uploads.createFileUpload(ctx, { buffer: Buffer.from(text), filename: 'gate.txt' }));
    await expectGated(uploads.createNote(ctx, { text, title: 'Gate' }));

    expect(await uploadRows()).toEqual([]);
    expect(await jobRows()).toEqual([]);
    expect(await sourceRows()).toEqual([]);
    expect(await readdir(TMP_DIR)).toEqual(filesBefore);
    expect(enqueue).not.toHaveBeenCalled();

    await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);

    const file = await uploads.createFileUpload(ctx, { buffer: Buffer.from(text), filename: 'gate.txt' });
    const note = await uploads.createNote(ctx, { text, title: 'Gate' });
    expect(file.uploadId).toBeTruthy();
    expect(note.uploadId).toBeTruthy();
    expect(await uploadRows()).toHaveLength(2);
    expect(await jobRows()).toHaveLength(2);
    expect(vi.mocked(enqueue).mock.calls.filter(([name]) => name === 'upload.process')).toHaveLength(2);
  });
});

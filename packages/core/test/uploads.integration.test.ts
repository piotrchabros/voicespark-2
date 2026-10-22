import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  connectedSource,
  contentItem,
  deletionRequest,
  FILTER_CATEGORIES,
  filterPreferences,
  getDb,
  getPool,
  importJob,
  upload,
  user,
} from '@voicespark/db';
import { and, eq, inArray } from 'drizzle-orm';
import { decryptBuffer } from '@voicespark/core/crypto';
import { resetEnvForTests } from '@voicespark/core/env';
import { enqueue } from '@voicespark/core/queues';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import * as uploads from '@voicespark/core/services/uploads';

// US4 uploads service (T109). Postgres only; queues are mocked and the staging dir is a fresh temp dir.
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

const TXT = 'A quiet afternoon spent writing about gardens and the slow turning of seasons.';

/** Minimal PNG: signature plus an IHDR chunk. */
function pngBytes(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    len,
    Buffer.from('IHDR'),
    ihdr,
    Buffer.alloc(4),
  ]);
}

const userIds: string[] = [];

async function createUser(confirmed: boolean): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Uploader', email: `uploads-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  const ctx: ServiceContext = { userId: row!.id, role: 'user' };
  if (confirmed) await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);
  return ctx;
}

async function createUnconfirmedRow(): Promise<ServiceContext> {
  const ctx = await createUser(false);
  await getDb()
    .insert(filterPreferences)
    .values({ userId: ctx.userId, selectedCategories: [...FILTER_CATEGORIES], confirmedAt: null });
  return ctx;
}

const uploadRows = (userId: string) => getDb().select().from(upload).where(eq(upload.userId, userId));
const jobRows = (userId: string) => getDb().select().from(importJob).where(eq(importJob.userId, userId));
const uploadsSources = (userId: string) =>
  getDb()
    .select()
    .from(connectedSource)
    .where(and(eq(connectedSource.userId, userId), eq(connectedSource.type, 'uploads')));

async function findUpload(id: string) {
  const [row] = await getDb().select().from(upload).where(eq(upload.id, id));
  return row;
}

async function caught(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getPool().query('delete from deletion_request where user_id = any($1::uuid[])', [userIds]);
    await getDb().delete(user).where(inArray(user.id, userIds));
  }
  await closeDb();
});

describe('first-import gate (FR-061)', () => {
  it.each([
    ['no filter_preferences row', () => createUser(false)],
    ['confirmed_at null', createUnconfirmedRow],
  ] as const)('rejects createFileUpload and createNote before any I/O (%s)', async (_label, make) => {
    const ctx = await make();
    const before = await readdir(TMP_DIR);

    for (const call of [
      () => uploads.createFileUpload(ctx, { buffer: Buffer.from(TXT), filename: 'gate.txt' }),
      () => uploads.createNote(ctx, { text: TXT, title: 'Gate' }),
    ]) {
      const err = await caught(call());
      expect(err.code).toBe('filter_confirmation_required');
      expect(err.status).toBe(409);
    }

    expect(await uploadRows(ctx.userId)).toEqual([]);
    expect(await jobRows(ctx.userId)).toEqual([]);
    expect(await uploadsSources(ctx.userId)).toEqual([]);
    expect(await readdir(TMP_DIR)).toEqual(before);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('createFileUpload synchronous rejects', () => {
  afterEach(() => {
    delete process.env.UPLOAD_MAX_BYTES;
    resetEnvForTests();
  });

  it('rejects a png with unsupported_type (415) and writes nothing', async () => {
    const ctx = await createUser(true);
    const err = await caught(uploads.createFileUpload(ctx, { buffer: pngBytes(), filename: 'pic.png' }));
    expect(err.code).toBe('unsupported_type');
    expect(err.status).toBe(415);
    expect(await uploadRows(ctx.userId)).toEqual([]);
    expect(await jobRows(ctx.userId)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a file over UPLOAD_MAX_BYTES with too_large (413)', async () => {
    process.env.UPLOAD_MAX_BYTES = '1024';
    resetEnvForTests();
    const ctx = await createUser(true);
    const err = await caught(
      uploads.createFileUpload(ctx, { buffer: Buffer.alloc(2048, 'a'), filename: 'big.txt' }),
    );
    expect(err.code).toBe('too_large');
    expect(err.status).toBe(413);
    expect(await uploadRows(ctx.userId)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('records a zero-byte file as rejected/empty with no staged file and no job', async () => {
    const ctx = await createUser(true);
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.alloc(0), filename: 'empty.txt' });
    const row = await findUpload(uploadId);
    expect(row?.status).toBe('rejected');
    expect(row?.rejectReason).toBe('empty');
    expect(row?.importJobId).toBeNull();
    expect(row?.stagingPath).toBeNull();
    expect(await jobRows(ctx.userId)).toEqual([]);
    expect(await exists(join(TMP_DIR, `${uploadId}.enc`))).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('createFileUpload / createNote accepted path', () => {
  it('stages the encrypted bytes, creates the uploads source, an upload job and enqueues upload.process', async () => {
    const ctx = await createUser(true);
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.from(TXT), filename: 'notes.txt' });

    const row = await findUpload(uploadId);
    expect(row).toMatchObject({
      userId: ctx.userId,
      kind: 'file',
      filename: 'notes.txt',
      status: 'received',
      authorship: 'authored',
      rejectReason: null,
      contentItemId: null,
    });
    expect(row?.sizeBytes).toBe(Buffer.byteLength(TXT));

    const [src] = await uploadsSources(ctx.userId);
    expect(src?.accountLabel).toBe('Uploads & notes');
    expect(row?.sourceId).toBe(src?.id);

    const [job] = await jobRows(ctx.userId);
    expect(job?.id).toBe(row?.importJobId);
    expect(job?.kind).toBe('upload');
    expect(job?.status).toBe('queued');
    expect(job?.sourceId).toBe(src?.id);

    expect(row?.stagingPath).toBe(join(TMP_DIR, `${uploadId}.enc`));
    const staged = await readFile(row!.stagingPath!);
    expect(staged.includes(Buffer.from(TXT))).toBe(false);
    expect(staged.toString('utf8')).not.toContain('gardens');
    expect(decryptBuffer('upload-staging', staged.toString('utf8')).toString('utf8')).toBe(TXT);

    expect(enqueue).toHaveBeenCalledWith(
      'upload.process',
      { userId: ctx.userId, uploadId, importJobId: row!.importJobId },
      { jobId: `upload-${uploadId}` },
    );
  });

  it('keeps authorship received when the toggle is off', async () => {
    const ctx = await createUser(true);
    const { uploadId } = await uploads.createFileUpload(ctx, {
      buffer: Buffer.from(TXT),
      filename: 'letter.md',
      authorship: 'received',
    });
    expect((await findUpload(uploadId))?.authorship).toBe('received');
  });

  it('creates the uploads source exactly once under two concurrent uploads, and both succeed', async () => {
    const ctx = await createUser(true);
    const [a, b] = await Promise.all([
      uploads.createFileUpload(ctx, { buffer: Buffer.from(`${TXT} first`), filename: 'a.txt' }),
      uploads.createFileUpload(ctx, { buffer: Buffer.from(`${TXT} second`), filename: 'b.txt' }),
    ]);
    expect(a.uploadId).not.toBe(b.uploadId);
    expect(await uploadsSources(ctx.userId)).toHaveLength(1);
    expect(await jobRows(ctx.userId)).toHaveLength(2);
  });

  it('accepts two uploads in a row while the first job is still queued (D-U1)', async () => {
    const ctx = await createUser(true);
    await uploads.createFileUpload(ctx, { buffer: Buffer.from(TXT), filename: 'one.txt' });
    await uploads.createFileUpload(ctx, { buffer: Buffer.from(`${TXT} again`), filename: 'two.txt' });
    const rows = await uploadRows(ctx.userId);
    expect(rows.map((r) => r.status)).toEqual(['received', 'received']);
    const jobs = await jobRows(ctx.userId);
    expect(jobs.map((j) => j.status)).toEqual(['queued', 'queued']);
  });

  it('stages a note as kind note with a null filename', async () => {
    const ctx = await createUser(true);
    const { uploadId } = await uploads.createNote(ctx, { text: TXT, title: 'Seasons' });
    const row = await findUpload(uploadId);
    expect(row).toMatchObject({ kind: 'note', filename: null, status: 'received', authorship: 'authored' });
    const staged = await readFile(row!.stagingPath!, 'utf8');
    expect(staged).not.toContain('gardens');
    expect(staged).not.toContain('Seasons');
    const payload = JSON.parse(decryptBuffer('upload-staging', staged).toString('utf8')) as unknown;
    expect(payload).toEqual({ text: TXT, title: 'Seasons' });
    expect(enqueue).toHaveBeenCalledWith(
      'upload.process',
      { userId: ctx.userId, uploadId, importJobId: row!.importJobId },
      { jobId: `upload-${uploadId}` },
    );
  });

  it('rejects a blank note with validation_failed', async () => {
    const ctx = await createUser(true);
    const err = await caught(uploads.createNote(ctx, { text: '   ' }));
    expect(err.code).toBe('validation_failed');
    expect(await uploadRows(ctx.userId)).toEqual([]);
  });
});

describe('list / get / remove', () => {
  it('lists and gets only the caller’s uploads', async () => {
    const owner = await createUser(true);
    const other = await createUser(true);
    const { uploadId } = await uploads.createFileUpload(owner, { buffer: Buffer.from(TXT), filename: 'mine.txt' });

    const page = await uploads.list(owner, { limit: 20 });
    expect(page.items.map((i) => i.id)).toEqual([uploadId]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toMatchObject({ kind: 'file', filename: 'mine.txt', status: 'received' });

    expect((await uploads.get(owner, uploadId)).id).toBe(uploadId);
    expect((await uploads.list(other, { limit: 20 })).items).toEqual([]);
    expect((await caught(uploads.get(other, uploadId))).code).toBe('not_found');
    expect((await caught(uploads.remove(other, uploadId))).code).toBe('not_found');
    expect((await caught(uploads.get(owner, 'not-a-uuid'))).code).toBe('not_found');
  });

  it('refuses to remove an upload that is still received', async () => {
    const ctx = await createUser(true);
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.from(TXT), filename: 'busy.txt' });
    expect((await caught(uploads.remove(ctx, uploadId))).code).toBe('conflict');
    expect(await findUpload(uploadId)).toBeDefined();
  });

  it('deletes a rejected upload row without a deletion request', async () => {
    const ctx = await createUser(true);
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.alloc(0), filename: 'empty.txt' });
    expect(await uploads.remove(ctx, uploadId)).toEqual({ deletionRequestId: null });
    expect(await findUpload(uploadId)).toBeUndefined();
  });

  it('removes a stored upload through a content_item deletion request', async () => {
    const ctx = await createUser(true);
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.from(TXT), filename: 'kept.txt' });
    const itemId = randomUUID();
    await getDb().insert(contentItem).values({
      id: itemId,
      userId: ctx.userId,
      kind: 'file',
      authorship: 'authored',
      itemDate: new Date(),
      wordCount: 12,
      contentHash: randomBytes(32).toString('hex'),
      filterPolicyVersion: 1,
      status: 'active',
    });
    await getDb()
      .update(upload)
      .set({ status: 'stored', contentItemId: itemId, stagingPath: null })
      .where(eq(upload.id, uploadId));

    const { deletionRequestId } = await uploads.remove(ctx, uploadId);
    expect(deletionRequestId).toBeTruthy();
    const [req] = await getDb().select().from(deletionRequest).where(eq(deletionRequest.id, deletionRequestId!));
    expect(req).toMatchObject({ userId: ctx.userId, scope: 'content_item', targetId: itemId, requestedBy: 'user' });
    expect(await findUpload(uploadId)).toBeUndefined();
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  contentItem,
  contentItemOccurrence,
  exclusionRecord,
  FILTER_CATEGORIES,
  getDb,
  getPool,
  importJob,
  upload,
  user,
} from '@voicespark/db';
import { eq, inArray } from 'drizzle-orm';
import { resetEnvForTests } from '@voicespark/core/env';
import { enqueue, jobIds, type JobPayload } from '@voicespark/core/queues';
import type { ServiceContext } from '@voicespark/core/errors';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import { getClassifier } from '@voicespark/core/services/inspection';
import * as uploads from '@voicespark/core/services/uploads';
import { InMemoryMemoryStore, META, namespaceFor } from '@voicespark/integrations/supermemory';
import {
  makeDocx,
  makeEncryptedPdf,
  makePdf,
  makeScannedPdf,
} from '../../../packages/integrations/test/helpers/fixtures';
import { createUploadHandler } from '../src/processors/upload';

// US4 upload.process (T110, jobs.md behavior 3). Postgres + the in-memory store; queues are mocked and every upload is
// created through the real uploads service, then processed by calling the handler directly.
type UploadPayload = JobPayload<'upload.process'>;

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
process.env.UPLOAD_TMP_DIR = mkdtempSync(join(tmpdir(), 'vs-up-'));
resetEnvForTests();

const PROSE = 'A quiet afternoon spent writing about gardens and the slow turning of seasons in the valley.';
const API_KEY = 'sk_live_dWh1HADnEIwLi2jv8DTmESwq';
// Credential delivery (reset phrase + reset link): the whole item is excluded by stage 2 of the pipeline.
const RESET_MAIL =
  'Please reset your password using this link: https://accounts.example.test/reset?token=Zx81Qw93Lm20Pa77Rt44 before Friday.';

const store = new InMemoryMemoryStore();
let handler: ReturnType<typeof createUploadHandler>;

function fakeJob(payload: UploadPayload, attemptsMade = 0) {
  return {
    id: jobIds.upload(payload.uploadId),
    name: 'upload.process',
    data: payload,
    attemptsMade,
    opts: { attempts: 3 },
    moveToDelayed: vi.fn(async () => undefined),
    updateData: vi.fn(async () => undefined),
  };
}

const userIds: string[] = [];

async function createUser(): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Uploader', email: `upload-${randomUUID()}@example.test` })
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

const itemsOf = (userId: string) => getDb().select().from(contentItem).where(eq(contentItem.userId, userId));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Runs upload.process for the upload; returns the handler result plus the upload row before processing. */
async function runUpload(uploadId: string, attemptsMade = 0) {
  const before = await findUpload(uploadId);
  const payload: UploadPayload = { userId: before.userId, uploadId, importJobId: before.importJobId! };
  const result = (await handler(
    fakeJob(payload, attemptsMade) as unknown as Job<UploadPayload, unknown, 'upload.process'>,
    'token',
  )) as { outcome: string; rejectReason?: string };
  return { result, before };
}

beforeAll(async () => {
  await getPool().query('select 1');
  handler = createUploadHandler({ store, classifier: getClassifier() });
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

describe('upload.process stores accepted uploads', () => {
  it.each([
    ['txt', 'essay.txt', () => Buffer.from(PROSE)],
    ['md', 'essay.md', () => Buffer.from(`# Seasons\n\n${PROSE}`)],
    ['pdf', 'essay.pdf', () => makePdf(PROSE)],
    ['docx', 'essay.docx', () => makeDocx([PROSE, 'Warm regards from the hills.'])],
  ] as const)('%s reaches stored with an active authored file item and a Title: document', async (_t, filename, build) => {
    const ctx = await createUser();
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: build(), filename });
    const { result, before } = await runUpload(uploadId);

    expect(result.outcome).toBe('stored');
    const row = await findUpload(uploadId);
    expect(row.status).toBe('stored');
    expect(row.rejectReason).toBeNull();
    expect(row.stagingPath).toBeNull();
    expect(await exists(before.stagingPath!)).toBe(false);

    const [item] = await itemsOf(ctx.userId);
    expect(item?.id).toBe(row.contentItemId);
    expect(item).toMatchObject({ kind: 'file', authorship: 'authored', status: 'active' });

    const occurrences = await getDb()
      .select()
      .from(contentItemOccurrence)
      .where(eq(contentItemOccurrence.contentItemId, item!.id));
    expect(occurrences.map((o) => o.sourceId)).toEqual([row.sourceId]);

    const doc = await store.getDocument(namespaceFor(ctx.userId), item!.id);
    expect(doc?.content.startsWith(`Title: ${filename}\n\n`)).toBe(true);
    expect(doc?.content).toContain('slow turning of seasons');
    expect(doc?.metadata[META.kind]).toBe('file');
    expect(doc?.metadata[META.authorship]).toBe('authored');

    const job = await findJob(row.importJobId!);
    expect(job.status).toBe('completed');
    expect(job.itemsProcessed).toBe(1);
    expect(job.itemsImported).toBe(1);
  });

  it('stores a note as kind note with its title, honouring the received authorship toggle', async () => {
    const ctx = await createUser();
    const { uploadId } = await uploads.createNote(ctx, { text: PROSE, title: 'Valley notes', authorship: 'received' });
    const { result, before } = await runUpload(uploadId);

    expect(result.outcome).toBe('stored');
    const row = await findUpload(uploadId);
    expect(row.status).toBe('stored');
    expect(await exists(before.stagingPath!)).toBe(false);
    const [item] = await itemsOf(ctx.userId);
    expect(item).toMatchObject({ id: row.contentItemId, kind: 'note', authorship: 'received', status: 'active' });

    const doc = await store.getDocument(namespaceFor(ctx.userId), item!.id);
    expect(doc?.content.startsWith('Title: Valley notes\n\n')).toBe(true);
    expect(doc?.metadata[META.kind]).toBe('note');
    expect(doc?.metadata[META.authorship]).toBe('received');
  });

  it('redacts an API key in an accepted file and never stores the value', async () => {
    const ctx = await createUser();
    const text = `Deploy notes for the team.\napi_key=${API_KEY}\n${PROSE}`;
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.from(text), filename: 'deploy.txt' });
    const { result } = await runUpload(uploadId);

    expect(result.outcome).toBe('stored');
    const row = await findUpload(uploadId);
    const doc = await store.getDocument(namespaceFor(ctx.userId), row.contentItemId!);
    expect(doc?.content).toBeDefined();
    expect(doc?.content).not.toContain(API_KEY);
    expect(JSON.stringify(doc?.metadata)).not.toContain(API_KEY);
  });

  it('dedups identical text: the second upload is stored against the same content item', async () => {
    const ctx = await createUser();
    const first = await uploads.createFileUpload(ctx, { buffer: Buffer.from(PROSE), filename: 'same.txt' });
    await runUpload(first.uploadId);
    const second = await uploads.createFileUpload(ctx, { buffer: Buffer.from(PROSE), filename: 'same.txt' });
    const { result, before } = await runUpload(second.uploadId);

    expect(['stored', 'duplicate']).toContain(result.outcome);
    const a = await findUpload(first.uploadId);
    const b = await findUpload(second.uploadId);
    expect(b.status).toBe('stored');
    expect(b.contentItemId).toBe(a.contentItemId);
    expect(await itemsOf(ctx.userId)).toHaveLength(1);
    expect(await exists(before.stagingPath!)).toBe(false);

    const job = await findJob(b.importJobId!);
    expect(job.status).toBe('completed');
    expect(job.itemsDuplicate).toBe(1);
    expect(job.itemsImported).toBe(0);
  });
});

describe('upload.process rejects', () => {
  it.each([
    ['scanned pdf', 'scan.pdf', () => makeScannedPdf(), 'no_text'],
    ['encrypted pdf', 'locked.pdf', () => makeEncryptedPdf(), 'encrypted'],
  ] as const)('%s -> rejected %s, nothing stored', async (_t, filename, build, reason) => {
    const ctx = await createUser();
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: build(), filename });
    const { result, before } = await runUpload(uploadId);

    expect(result.outcome).toBe('rejected');
    const row = await findUpload(uploadId);
    expect(row.status).toBe('rejected');
    expect(row.rejectReason).toBe(reason);
    expect(row.contentItemId).toBeNull();
    expect(row.stagingPath).toBeNull();
    expect(await exists(before.stagingPath!)).toBe(false);
    expect(await itemsOf(ctx.userId)).toEqual([]);
    expect((await store.listDocuments(namespaceFor(ctx.userId), { page: 1, limit: 10 })).documents).toEqual([]);
    expect((await findJob(row.importJobId!)).status).toBe('completed');
  });

  it('rejects a wholly excluded upload as sensitive_content and records the exclusion', async () => {
    const ctx = await createUser();
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.from(RESET_MAIL), filename: 'mail.txt' });
    const { result, before } = await runUpload(uploadId);

    expect(result).toMatchObject({ outcome: 'rejected', rejectReason: 'sensitive_content' });
    const row = await findUpload(uploadId);
    expect(row.status).toBe('rejected');
    expect(row.rejectReason).toBe('sensitive_content');
    expect(await exists(before.stagingPath!)).toBe(false);
    expect(await itemsOf(ctx.userId)).toEqual([]);
    const docs = await store.listDocuments(namespaceFor(ctx.userId), { page: 1, limit: 10 });
    expect(docs.documents).toEqual([]);

    const records = await getDb()
      .select()
      .from(exclusionRecord)
      .where(eq(exclusionRecord.importJobId, row.importJobId!));
    expect(records).toEqual([
      expect.objectContaining({ category: 'reset_verification_links', excludedItems: 1 }),
    ]);
    const job = await findJob(row.importJobId!);
    expect(job.status).toBe('completed');
    expect(job.itemsProcessed).toBe(1);
    expect(job.itemsExcluded).toBe(1);
  });
});

describe('upload.process failures', () => {
  it('rolls back the rows and keeps the staged file when Supermemory fails, then succeeds on retry', async () => {
    const ctx = await createUser();
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.from(PROSE), filename: 'retry.txt' });
    const spy = vi.spyOn(store, 'addDocuments').mockRejectedValueOnce(new Error('supermemory unavailable'));
    try {
      const before = await findUpload(uploadId);
      const payload: UploadPayload = { userId: ctx.userId, uploadId, importJobId: before.importJobId! };
      await expect(
        handler(fakeJob(payload) as unknown as Job<UploadPayload, unknown, 'upload.process'>, 'token'),
      ).rejects.toThrow();

      expect(await itemsOf(ctx.userId)).toEqual([]);
      const row = await findUpload(uploadId);
      expect(row.status).not.toBe('stored');
      expect(row.stagingPath).toBe(before.stagingPath);
      expect(await exists(before.stagingPath!)).toBe(true);
    } finally {
      spy.mockRestore();
    }

    const { result } = await runUpload(uploadId, 1);
    expect(result.outcome).toBe('stored');
    expect((await findUpload(uploadId)).status).toBe('stored');
    expect(await itemsOf(ctx.userId)).toHaveLength(1);
  });

  it('skips an upload that is already terminal', async () => {
    const ctx = await createUser();
    const { uploadId } = await uploads.createFileUpload(ctx, { buffer: Buffer.from(PROSE), filename: 'twice.txt' });
    await runUpload(uploadId);
    const { result } = await runUpload(uploadId);
    expect(result.outcome).toBe('skipped');
    expect(await itemsOf(ctx.userId)).toHaveLength(1);
  });
});

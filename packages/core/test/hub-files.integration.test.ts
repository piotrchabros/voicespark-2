import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt, encrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import * as files from '@voicespark/core/services/hub/files';
import * as records from '@voicespark/core/services/hub/records';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US2 files service (T062; data-model.md "hub_file", "Files and blob store"; contracts/http-api.md "Files (US2)";
// contracts/memory-store-hub.md "Outbox"; FR-009). The original blob is kept encrypted and owner-only.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

const FILES_DIR = mkdtempSync(join(tmpdir(), 'hub-files-'));
process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.HUB_FILES_DIR = FILES_DIR;
process.env.HUB_FILE_MAX_BYTES = String(64 * 1024);
process.env.NODE_ENV ??= 'test';

const MAX = 64 * 1024;
const CARD = '4111 1111 1111 1111';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f20000000049454e44ae426082',
  'hex',
);
const TXT = Buffer.from('quarterly roadmap notes\n');

async function expectCode(p: Promise<unknown>, code: string, status?: number): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status !== undefined) expect((err as AppError).status).toBe(status);
  return err as AppError;
}

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function setup(): Promise<{ ctx: ServiceContext; personId: string }> {
  const ctx: ServiceContext = { userId: await createUser(), role: 'user' };
  const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak' });
  return { ctx, personId: record.id };
}

async function fileRow(id: string) {
  const [r] = await q<{
    user_id: string;
    person_id: string | null;
    name_enc: string;
    description_enc: string | null;
    mime_type: string;
    extension: string;
    size_bytes: string;
    sha256: string;
    storage_key: string;
    key_id: string;
    extraction_status: string;
  }>('select * from hub_file where id = $1', [id]);
  return r;
}

async function syncRow(userId: string, type: string, id: string) {
  const [r] = await q<{ version: number; deleted: boolean }>(
    `select version::int as version, deleted from hub_sync_item where user_id = $1 and doc_id = $2`,
    [userId, `hub_${type}_${id}`],
  );
  return r;
}

async function searchDoc(userId: string, id: string) {
  const [r] = await q<{ tokens: string[]; owner_kind: string; owner_id: string }>(
    `select tokens, owner_kind, owner_id from hub_search_doc where user_id = $1 and item_type = 'file' and item_id = $2`,
    [userId, id],
  );
  return r ? { ...r, tokens: r.tokens.map((t) => t.trim()) } : null;
}

const blobPath = (userId: string, storageKey: string) => join(FILES_DIR, userId, `${storageKey}.bin`);

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('upload', () => {
  it('stores the row pending, the encrypted blob, the search row, marks dirty and enqueues extraction', async () => {
    const { ctx, personId } = await setup();
    const { file, sync } = await files.upload(ctx, 'person', personId, {
      bytes: PDF,
      filename: 'Roadmap Q3.PDF',
      description: 'board deck',
    });
    expect(file).toMatchObject({
      ownerKind: 'person',
      ownerId: personId,
      name: 'Roadmap Q3.PDF',
      description: 'board deck',
      mimeType: 'application/pdf',
      extension: 'pdf',
      sizeBytes: PDF.length,
      extractionStatus: 'pending',
      extractionReason: null,
      redactedValues: 0,
    });
    expect(sync.status).toBe('pending');

    const row = await fileRow(file.id);
    expect(row!.extraction_status).toBe('pending');
    expect(row!.key_id).toBe('k1');
    expect(row!.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(decrypt('user-content', row!.name_enc)).toBe('Roadmap Q3.PDF');

    // Encrypted at rest: the plaintext never lands on disk.
    const onDisk = readFileSync(blobPath(ctx.userId, row!.storage_key));
    expect(onDisk.includes(PDF)).toBe(false);

    const doc = await searchDoc(ctx.userId, file.id);
    expect(doc).toMatchObject({ owner_kind: 'person', owner_id: personId });
    expect(doc!.tokens).toEqual(expect.arrayContaining(indexTokens(ctx.userId, ['Roadmap', 'board', 'deck'])));

    expect(await syncRow(ctx.userId, 'file', file.id)).toMatchObject({ deleted: false });
    expect(await syncRow(ctx.userId, 'person', personId)).toBeDefined();

    expect(enqueue).toHaveBeenCalledWith(
      'hub.file-extract',
      { userId: ctx.userId, fileId: file.id },
      expect.objectContaining({ jobId: `hubfile-${file.id}` }),
    );
  });

  it('accepts images and text', async () => {
    const { ctx, personId } = await setup();
    const png = await files.upload(ctx, 'person', personId, { bytes: PNG, filename: 'logo.png' });
    expect(png.file).toMatchObject({ extension: 'png', mimeType: 'image/png', description: null });
    const txt = await files.upload(ctx, 'person', personId, { bytes: TXT, filename: 'notes.txt' });
    expect(txt.file.extension).toBe('txt');
  });

  it('over HUB_FILE_MAX_BYTES -> 413 too_large, nothing stored', async () => {
    const { ctx, personId } = await setup();
    const big = Buffer.concat([TXT, Buffer.alloc(MAX, 0x61)]);
    await expectCode(files.upload(ctx, 'person', personId, { bytes: big, filename: 'big.txt' }), 'too_large', 413);
    expect(await q('select id from hub_file where user_id = $1', [ctx.userId])).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalledWith('hub.file-extract', expect.anything(), expect.anything());
  });

  it('wrong type -> 415 unsupported_type with details.allowed, nothing stored', async () => {
    const { ctx, personId } = await setup();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]);
    for (const [bytes, filename] of [
      [svg, 'x.svg'],
      [exe, 'invoice.pdf'],
      [PNG, 'photo.pdf'],
      [TXT, 'noext'],
    ] as const) {
      const err = await expectCode(
        files.upload(ctx, 'person', personId, { bytes, filename }),
        'unsupported_type',
        415,
      );
      expect(err.details?.allowed).toEqual(expect.arrayContaining(['pdf', 'docx', 'png', 'markdown']));
      expect(err.details?.allowed).toHaveLength(20);
    }
    expect(await q('select id from hub_file where user_id = $1', [ctx.userId])).toHaveLength(0);
  });

  it('a bad name -> 422 validation_failed', async () => {
    const { ctx, personId } = await setup();
    for (const filename of ['a/b.txt', 'a\\b.txt', 'a\u0007.txt', `${'a'.repeat(252)}.txt`]) {
      await expectCode(files.upload(ctx, 'person', personId, { bytes: TXT, filename }), 'validation_failed', 422);
    }
  });

  it('an unknown or foreign owner record -> 404', async () => {
    const { ctx } = await setup();
    const other = await setup();
    await expectCode(
      files.upload(ctx, 'person', other.personId, { bytes: TXT, filename: 'a.txt' }),
      'not_found',
      404,
    );
    await expectCode(
      files.upload(ctx, 'company', other.personId, { bytes: TXT, filename: 'a.txt' }),
      'not_found',
      404,
    );
  });

  it('name and description pass inspection: stored redacted with redactedValues', async () => {
    const { ctx, personId } = await setup();
    const res = await files.upload(ctx, 'person', personId, {
      bytes: TXT,
      filename: 'notes.txt',
      description: `card ${CARD} on file`,
    });
    expect(res.redactedValues).toBe(1);
    expect(res.file.description).not.toContain('4111');
    const row = await fileRow(res.file.id);
    expect(decrypt('user-content', row!.description_enc!)).not.toContain('4111');
  });
});

describe('list, get, patch', () => {
  it('lists the files of a record with sync, newest first; get returns {file, sync}', async () => {
    const { ctx, personId } = await setup();
    const a = await files.upload(ctx, 'person', personId, { bytes: TXT, filename: 'a.txt' });
    const b = await files.upload(ctx, 'person', personId, { bytes: PNG, filename: 'b.png' });
    const items = await files.list(ctx, 'person', personId);
    expect(items.map((f) => f.id)).toEqual([b.file.id, a.file.id]);
    expect(items[0]!.sync.status).toBe('pending');

    const got = await files.get(ctx, a.file.id);
    expect(got.file).toMatchObject({ id: a.file.id, name: 'a.txt' });
    expect(got.sync).toMatchObject({ status: 'pending', lastSyncedAt: null });

    const other = await setup();
    await expectCode(files.get(other.ctx, a.file.id), 'not_found', 404);
    await expectCode(files.list(other.ctx, 'person', personId), 'not_found', 404);
  });

  it('patch renames and describes, reindexes, keeps extracted text tokens and marks dirty', async () => {
    const { ctx, personId } = await setup();
    const { file } = await files.upload(ctx, 'person', personId, { bytes: TXT, filename: 'a.txt' });
    // Simulate the worker having stored extracted text.
    await q(`update hub_file set extraction_status = 'extracted', extracted_text_enc = $2 where id = $1`, [
      file.id,
      encrypt('user-content', 'zeppelin manifest'),
    ]);
    const before = (await syncRow(ctx.userId, 'file', file.id))!.version;

    const res = await files.patch(ctx, file.id, { name: 'renamed.txt', description: 'kickoff agenda' });
    expect(res.file).toMatchObject({ name: 'renamed.txt', description: 'kickoff agenda', extractionStatus: 'extracted' });
    const doc = await searchDoc(ctx.userId, file.id);
    expect(doc!.tokens).toEqual(expect.arrayContaining(indexTokens(ctx.userId, ['renamed', 'kickoff', 'zeppelin'])));
    expect((await syncRow(ctx.userId, 'file', file.id))!.version).toBeGreaterThan(before);

    const cleared = await files.patch(ctx, file.id, { description: null });
    expect(cleared.file.description).toBeNull();

    await expectCode(files.patch(ctx, file.id, { name: '' }), 'validation_failed', 422);
    await expectCode(files.patch(ctx, file.id, { name: 'a/b' }), 'validation_failed', 422);
    await expectCode(files.patch(ctx, file.id, {}), 'validation_failed', 422);
    const other = await setup();
    await expectCode(files.patch(other.ctx, file.id, { name: 'x.txt' }), 'not_found', 404);
  });
});

describe('download', () => {
  it('returns the decrypted original to the owner only', async () => {
    const { ctx, personId } = await setup();
    const { file } = await files.upload(ctx, 'person', personId, { bytes: PDF, filename: 'deck.pdf' });
    const dl = await files.download(ctx, file.id);
    expect(Buffer.from(dl.bytes).equals(PDF)).toBe(true);
    expect(dl).toMatchObject({ filename: 'deck.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length });

    const other = await setup();
    await expectCode(files.download(other.ctx, file.id), 'not_found', 404);
  });
});

describe('remove', () => {
  it('deletes the row and search row, tombstones, marks the owner dirty and removes the blob after commit', async () => {
    const { ctx, personId } = await setup();
    const { file } = await files.upload(ctx, 'person', personId, { bytes: TXT, filename: 'a.txt' });
    const row = await fileRow(file.id);
    const path = blobPath(ctx.userId, row!.storage_key);
    expect(existsSync(path)).toBe(true);
    const ownerBefore = (await syncRow(ctx.userId, 'person', personId))!.version;

    const other = await setup();
    await expectCode(files.remove(other.ctx, file.id), 'not_found', 404);
    expect(existsSync(path)).toBe(true);

    await files.remove(ctx, file.id);
    expect(await fileRow(file.id)).toBeUndefined();
    expect(await searchDoc(ctx.userId, file.id)).toBeNull();
    expect(await syncRow(ctx.userId, 'file', file.id)).toMatchObject({ deleted: true });
    expect((await syncRow(ctx.userId, 'person', personId))!.version).toBeGreaterThan(ownerBefore);
    expect(existsSync(path)).toBe(false);
    await expectCode(files.remove(ctx, file.id), 'not_found', 404);
  });
});

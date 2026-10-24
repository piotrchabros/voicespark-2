import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, FILTER_CATEGORIES, getDb, getPool, user } from '@voicespark/db';
import { inArray } from 'drizzle-orm';
import { decrypt, encrypt } from '@voicespark/core/crypto';
import { resetEnvForTests } from '@voicespark/core/env';
import type { ServiceContext } from '@voicespark/core/errors';
import { createFsBlobStore } from '@voicespark/core/hub/blob-store';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import { enqueue, jobIds, type JobPayload } from '@voicespark/core/queues';
import * as filterPrefs from '@voicespark/core/services/filter-preferences';
import * as records from '@voicespark/core/services/hub/records';
import type { Classifier } from '@voicespark/filters';
import { extractHubText } from '@voicespark/integrations/files';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import {
  makeDocx,
  makePdf,
  makeScannedPdf,
  makeStoredZip,
} from '../../../packages/integrations/test/helpers/fixtures';
import { createHubFileHandler } from '../src/processors/hub-file';
import { hubBlobSweep } from '../src/processors/maintenance';

// US2 hub.file-extract (T056, contracts/jobs.md (14); data-model.md "hub_file"; FR-009, FR-010, FR-028). Postgres,
// a temp HUB_FILES_DIR and the in-memory store; queues are mocked and the handler is called directly. Rows and blobs
// are seeded with raw SQL and the blob store, so the fixtures do not depend on the upload path.
type FilePayload = JobPayload<'hub.file-extract'>;

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

vi.mock('@voicespark/integrations/files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@voicespark/integrations/files')>();
  return { ...real, extractHubText: vi.fn(real.extractHubText) };
});

const FILES_DIR = mkdtempSync(join(tmpdir(), 'vs-hub-files-'));
process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';
// Must be set before the first loadEnv() call.
process.env.HUB_FILES_DIR = FILES_DIR;
resetEnvForTests();

const PROSE = 'Quarterly roadmap for the orchard cooperative and the valley harvest plans.';
const PASSWORD = 'Xk9#mPq2vLr7';
// Credential delivery (reset phrase + reset link): the whole item is excluded.
const RESET_MAIL =
  'Please reset your password using this link: https://accounts.example.test/reset?token=Zx81Qw93Lm20Pa77Rt44 before Friday.';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const TYPES = { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` };

function makeXlsx(text: string): Buffer {
  return makeStoredZip([
    TYPES,
    { name: 'xl/sharedStrings.xml', data: `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${text}</t></si></sst>` },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    },
  ]);
}

function makePptx(text: string): Buffer {
  return makeStoredZip([
    TYPES,
    {
      name: 'ppt/slides/slide1.xml',
      data: `${XML}<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
    },
  ]);
}

function makeOdf(mime: string, text: string): Buffer {
  return makeStoredZip([
    { name: 'mimetype', data: mime },
    {
      name: 'content.xml',
      data: `${XML}<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>${text}</text:p></office:text></office:body></office:document-content>`,
    },
  ]);
}

const ODF = 'application/vnd.oasis.opendocument';
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: `${ODF}.text`,
  ods: `${ODF}.spreadsheet`,
  odp: `${ODF}.presentation`,
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
};

/** Classifier that records every text it is given and answers "nothing sensitive" (or throws). */
function recordingClassifier(opts: { fail?: boolean } = {}): Classifier & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async classify(text) {
      texts.push(text);
      if (opts.fail) throw new Error('classifier unavailable');
      return { spans: [], mostlySensitive: false };
    },
  };
}

const store = new InMemoryMemoryStore();
const classifier = recordingClassifier();
const blobs = createFsBlobStore(FILES_DIR);
let handler: ReturnType<typeof createHubFileHandler>;

const userIds: string[] = [];

async function createUser(): Promise<ServiceContext> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Hub Filer', email: `hub-file-${randomUUID()}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  const ctx: ServiceContext = { userId: row!.id, role: 'user' };
  await filterPrefs.update(ctx, [...FILTER_CATEGORIES]);
  return ctx;
}

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

interface Seeded {
  ctx: ServiceContext;
  personId: string;
  fileId: string;
  storageKey: string;
}

/** A person record, the encrypted blob and a `pending` hub_file row (raw SQL, no upload path). */
async function seedFile(ext: string, bytes: Buffer, ctx?: ServiceContext): Promise<Seeded> {
  ctx ??= await createUser();
  const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak' });
  const storageKey = randomUUID();
  const { keyId } = await blobs.put(ctx.userId, storageKey, bytes);
  const [row] = await q<{ id: string }>(
    `insert into hub_file (user_id, person_id, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      ctx.userId,
      record.id,
      encrypt('user-content', `Plan.${ext}`),
      MIME[ext] ?? 'application/octet-stream',
      ext,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      storageKey,
      keyId,
    ],
  );
  return { ctx, personId: record.id, fileId: row!.id, storageKey };
}

async function fileRow(id: string) {
  const [r] = await q<{
    extraction_status: string;
    extraction_reason: string | null;
    extracted_text_enc: string | null;
    redacted_values: number;
  }>('select extraction_status, extraction_reason, extracted_text_enc, redacted_values from hub_file where id = $1', [id]);
  return r;
}

const textOf = (enc: string | null) => (enc === null ? null : decrypt('user-content', enc));

async function syncVersion(userId: string, fileId: string): Promise<number> {
  const [r] = await q<{ version: number }>(
    'select version::int as version from hub_sync_item where user_id = $1 and doc_id = $2',
    [userId, `hub_file_${fileId}`],
  );
  return r?.version ?? 0;
}

async function searchTokens(userId: string, fileId: string): Promise<string[]> {
  const [r] = await q<{ tokens: string[] }>(
    `select tokens from hub_search_doc where user_id = $1 and item_type = 'file' and item_id = $2`,
    [userId, fileId],
  );
  return (r?.tokens ?? []).map((t) => t.trim());
}

function fakeJob(payload: FilePayload, attemptsMade = 0) {
  return {
    id: jobIds.hubFile(payload.fileId),
    name: 'hub.file-extract',
    data: payload,
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job<FilePayload, unknown, 'hub.file-extract'>;
}

async function run(s: Seeded, attemptsMade = 0, h = handler) {
  return (await h(fakeJob({ userId: s.ctx.userId, fileId: s.fileId }, attemptsMade), 'token')) as { outcome: string };
}

const blobExists = (s: Seeded) => existsSync(join(FILES_DIR, s.ctx.userId, `${s.storageKey}.bin`));

beforeAll(async () => {
  await getPool().query('select 1');
  handler = createHubFileHandler({ store, classifier, blobStore: blobs });
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
  vi.mocked(extractHubText).mockClear();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getPool().query('delete from deletion_request where user_id = any($1::uuid[])', [userIds]);
    await getDb().delete(user).where(inArray(user.id, userIds));
  }
  await closeDb();
});

describe('hub.file-extract: extracted', () => {
  it.each([
    ['pdf', () => makePdf(`${PROSE} pdfmarker`), 'pdfmarker'],
    ['docx', () => makeDocx([`${PROSE} docxmarker`]), 'docxmarker'],
    ['xlsx', () => makeXlsx(`${PROSE} xlsxmarker`), 'xlsxmarker'],
    ['pptx', () => makePptx(`${PROSE} pptxmarker`), 'pptxmarker'],
    ['odt', () => makeOdf(`${ODF}.text`, `${PROSE} odtmarker`), 'odtmarker'],
    ['ods', () => makeOdf(`${ODF}.spreadsheet`, `${PROSE} odsmarker`), 'odsmarker'],
    ['odp', () => makeOdf(`${ODF}.presentation`, `${PROSE} odpmarker`), 'odpmarker'],
    ['csv', () => Buffer.from(`name,notes\nharvest,${PROSE} csvmarker\n`), 'csvmarker'],
    ['txt', () => Buffer.from(`${PROSE} txtmarker`), 'txtmarker'],
    ['md', () => Buffer.from(`# Plan\n\n${PROSE} mdmarker`), 'mdmarker'],
  ] as const)('%s -> extracted, text encrypted, indexed, sync item dirty', async (ext, build, marker) => {
    const s = await seedFile(ext, build());
    const before = await syncVersion(s.ctx.userId, s.fileId);
    const result = await run(s);

    expect(result.outcome).toBe('extracted');
    const row = await fileRow(s.fileId);
    expect(row).toMatchObject({ extraction_status: 'extracted', extraction_reason: null, redacted_values: 0 });
    expect(textOf(row!.extracted_text_enc)).toContain(marker);
    expect(await searchTokens(s.ctx.userId, s.fileId)).toEqual(
      expect.arrayContaining(indexTokens(s.ctx.userId, [marker])),
    );
    expect(await syncVersion(s.ctx.userId, s.fileId)).toBeGreaterThan(before);
    expect(vi.mocked(extractHubText)).toHaveBeenCalledWith(expect.anything(), ext, { timeoutMs: 30_000 });
  });

  it('stores at most 1,000,000 chars and indexes only the first 90,000', async () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(4000); // 108,000 chars
    const s = await seedFile('txt', Buffer.from(`earlymarker ${filler} latemarker ${'quiet garden words '.repeat(60_000)}`));
    await run(s);

    const row = await fileRow(s.fileId);
    expect(row!.extraction_status).toBe('extracted');
    const text = textOf(row!.extracted_text_enc)!;
    expect(text.length).toBeLessThanOrEqual(1_000_000);
    expect(text).toContain('latemarker');
    const tokens = await searchTokens(s.ctx.userId, s.fileId);
    expect(tokens).toEqual(expect.arrayContaining(indexTokens(s.ctx.userId, ['earlymarker'])));
    expect(tokens).not.toEqual(expect.arrayContaining(indexTokens(s.ctx.userId, ['latemarker'])));
  }, 60_000);

  it('redacts a password in the text and sets redacted_values', async () => {
    const s = await seedFile('txt', Buffer.from(`${PROSE}\nThe server password: ${PASSWORD}\nThanks.`));
    await run(s);

    const row = await fileRow(s.fileId);
    expect(row!.extraction_status).toBe('extracted');
    expect(row!.redacted_values).toBeGreaterThan(0);
    expect(textOf(row!.extracted_text_enc)).not.toContain(PASSWORD);
    expect(await searchTokens(s.ctx.userId, s.fileId)).not.toEqual(
      expect.arrayContaining(indexTokens(s.ctx.userId, [PASSWORD])),
    );
  });
});

describe('hub.file-extract: not extracted', () => {
  it.each(['rtf', 'doc', 'xls', 'ppt'])('%s -> unsupported / no_text_extraction_for_type', async (ext) => {
    const s = await seedFile(ext, Buffer.from(`${PROSE} legacy`));
    expect((await run(s)).outcome).toBe('unsupported');
    expect(await fileRow(s.fileId)).toMatchObject({
      extraction_status: 'unsupported',
      extraction_reason: 'no_text_extraction_for_type',
      extracted_text_enc: null,
    });
  });

  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp'])('%s -> unsupported / image_not_searchable', async (ext) => {
    const s = await seedFile(ext, Buffer.from('not really an image'));
    await run(s);
    expect(await fileRow(s.fileId)).toMatchObject({
      extraction_status: 'unsupported',
      extraction_reason: 'image_not_searchable',
      extracted_text_enc: null,
    });
  });

  it('scanned pdf -> empty', async () => {
    const s = await seedFile('pdf', makeScannedPdf());
    await run(s);
    expect(await fileRow(s.fileId)).toMatchObject({ extraction_status: 'empty', extracted_text_enc: null });
  });

  it('a 30 s timeout -> failed / timeout', async () => {
    vi.mocked(extractHubText).mockImplementationOnce(async (_bytes, _ext, opts) => {
      expect(opts).toEqual({ timeoutMs: 30_000 });
      return { status: 'failed', reason: 'timeout' };
    });
    const s = await seedFile('docx', makeDocx([PROSE]));
    expect((await run(s)).outcome).toBe('failed');
    expect(await fileRow(s.fileId)).toMatchObject({
      extraction_status: 'failed',
      extraction_reason: 'timeout',
      extracted_text_enc: null,
    });
  });

  it('a corrupt file -> failed / corrupt', async () => {
    const s = await seedFile('xlsx', makeStoredZip([{ name: 'x', data: 'y' }]));
    await run(s);
    expect(await fileRow(s.fileId)).toMatchObject({ extraction_status: 'failed', extraction_reason: 'corrupt' });
  });
});

describe('hub.file-extract: filtering', () => {
  it('whole-item exclusion -> excluded with the category key, text discarded, blob kept, audit written', async () => {
    const s = await seedFile('txt', Buffer.from(RESET_MAIL));
    const before = await syncVersion(s.ctx.userId, s.fileId);
    expect((await run(s)).outcome).toBe('excluded');

    expect(await fileRow(s.fileId)).toMatchObject({
      extraction_status: 'excluded',
      extraction_reason: 'reset_verification_links',
      extracted_text_enc: null,
    });
    expect(blobExists(s)).toBe(true);
    expect(await searchTokens(s.ctx.userId, s.fileId)).not.toEqual(
      expect.arrayContaining(indexTokens(s.ctx.userId, ['reset'])),
    );
    expect(await syncVersion(s.ctx.userId, s.fileId)).toBeGreaterThan(before);
    const audits = await q<{ metadata: unknown; actor_type: string }>(
      `select metadata, actor_type from audit_log_entry where action = 'hub.file_excluded' and target_id = $1`,
      [s.fileId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ category: 'reset_verification_links' });
  });

  it('inspection failure retries per job attempts, then failed / inspection_failed with nothing indexed or synced', async () => {
    const failing = createHubFileHandler({ store, classifier: recordingClassifier({ fail: true }), blobStore: blobs });
    const s = await seedFile('txt', Buffer.from(`${PROSE} failmarker`));
    const before = await syncVersion(s.ctx.userId, s.fileId);
    const tokensBefore = await searchTokens(s.ctx.userId, s.fileId);

    // Attempts 1 and 2 throw (BullMQ retries); the row stays pending.
    await expect(run(s, 0, failing)).rejects.toThrow();
    await expect(run(s, 1, failing)).rejects.toThrow();
    expect(await fileRow(s.fileId)).toMatchObject({ extraction_status: 'pending', extracted_text_enc: null });

    // The last attempt settles the row.
    expect((await run(s, 2, failing)).outcome).toBe('failed');
    expect(await fileRow(s.fileId)).toMatchObject({
      extraction_status: 'failed',
      extraction_reason: 'inspection_failed',
      extracted_text_enc: null,
    });
    expect(await searchTokens(s.ctx.userId, s.fileId)).toEqual(tokensBefore);
    expect(await syncVersion(s.ctx.userId, s.fileId)).toBe(before);
    const audits = await q('select 1 from audit_log_entry where action = $1 and target_id = $2', [
      'hub.file_excluded',
      s.fileId,
    ]);
    expect(audits).toHaveLength(0);
  });

  it('never passes the blob to the classifier or the memory store', async () => {
    const add = vi.spyOn(store, 'addDocuments');
    const local = recordingClassifier();
    const h = createHubFileHandler({ store, classifier: local, blobStore: blobs });
    const docx = makeDocx([`${PROSE} blobcheck`]);
    const s = await seedFile('docx', docx);
    await run(s, 0, h);

    expect((await fileRow(s.fileId))!.extraction_status).toBe('extracted');
    expect(add).not.toHaveBeenCalled();
    for (const t of local.texts) {
      expect(t).not.toContain('word/document.xml');
      expect(t).not.toContain('PK\u0003\u0004');
    }
    add.mockRestore();
  });
});

describe('hub.file-extract: aborts', () => {
  it('finishes quietly when the row is gone', async () => {
    const s = await seedFile('txt', Buffer.from(PROSE));
    await q('delete from hub_file where id = $1', [s.fileId]);
    expect((await run(s)).outcome).toBe('skipped');
    expect(vi.mocked(extractHubText)).not.toHaveBeenCalled();
  });

  it('ignores a job for another user', async () => {
    const s = await seedFile('txt', Buffer.from(PROSE));
    const other = await createUser();
    const result = (await handler(fakeJob({ userId: other.userId, fileId: s.fileId }), 'token')) as { outcome: string };
    expect(result.outcome).toBe('skipped');
    expect((await fileRow(s.fileId))!.extraction_status).toBe('pending');
  });
});

describe('maintenance.hub-blob-sweep', () => {
  it('deletes blobs without a hub_file row older than 1 h and keeps rows, live blobs and fresh orphans', async () => {
    const live = await seedFile('txt', Buffer.from(PROSE));
    const dir = join(FILES_DIR, live.ctx.userId);
    const oldOrphan = join(dir, `${randomUUID()}.bin`);
    const freshOrphan = join(dir, `${randomUUID()}.bin`);
    await mkdir(dir, { recursive: true });
    await writeFile(oldOrphan, 'x');
    await writeFile(freshOrphan, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await utimes(oldOrphan, twoHoursAgo, twoHoursAgo);
    await utimes(join(dir, `${live.storageKey}.bin`), twoHoursAgo, twoHoursAgo);

    const result = await hubBlobSweep();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(freshOrphan)).toBe(true);
    expect(blobExists(live)).toBe(true);
    expect((await fileRow(live.fileId))!.extraction_status).toBe('pending');
  });
});

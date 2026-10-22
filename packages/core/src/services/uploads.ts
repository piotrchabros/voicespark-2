import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  connectedSource,
  getDb,
  upload,
  user,
  withTransaction,
  type Authorship,
  type DbOrTx,
  type Tx,
  type Upload,
  type UploadKind,
  type UploadRejectReason,
  type UploadStatus,
  type UserStatus,
} from '@voicespark/db';
import { sniffUpload } from '@voicespark/integrations/files';
import { decryptBuffer, encryptBuffer } from '../crypto';
import { loadEnv } from '../env';
import { AppError, type ServiceContext } from '../errors';
import { enqueue, jobIds } from '../queues';
import { requestDeletion } from './deletion';
import * as imports from './imports';

export interface UploadView {
  id: string;
  kind: UploadKind;
  filename: string | null;
  status: UploadStatus;
  rejectReason: UploadRejectReason | null;
  importJobId: string | null;
  contentItemId: string | null;
  createdAt: string;
}

export const NOTE_MAX_CHARS = 100_000;
export const NOTE_TITLE_MAX = 200;
export const FILENAME_MAX = 255;

const UPLOADS_SOURCE_LABEL = 'Uploads & notes';
const UPLOADS_CONSENT_VERSION = 'uploads-v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encrypted staging file for an upload (constitution VII). */
export function stagingPathFor(uploadId: string): string {
  return join(loadEnv().UPLOAD_TMP_DIR, `${uploadId}.enc`);
}

/**
 * The single `uploads` source of the user, created lazily. The advisory lock serializes concurrent first uploads
 * (the unique index does not cover a null `account_address`).
 */
export async function ensureUploadsSource(ctx: ServiceContext, db?: DbOrTx): Promise<{ id: string }> {
  const run = async (tx: DbOrTx): Promise<{ id: string }> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`uploads-source:${ctx.userId}`}))`);
    const [existing] = await tx
      .select({ id: connectedSource.id })
      .from(connectedSource)
      .where(
        and(
          eq(connectedSource.userId, ctx.userId),
          eq(connectedSource.type, 'uploads'),
          ne(connectedSource.status, 'disconnected'),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const [row] = await tx
      .insert(connectedSource)
      .values({
        userId: ctx.userId,
        type: 'uploads',
        accountLabel: UPLOADS_SOURCE_LABEL,
        accountAddress: null,
        status: 'connected',
        consentTextVersion: UPLOADS_CONSENT_VERSION,
      })
      .returning({ id: connectedSource.id });
    if (!row) throw new Error('uploads_source_insert_failed');
    return row;
  };
  return db ? run(db) : withTransaction(run);
}

function cleanFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop()?.trim() ?? '';
  return (base || 'upload').slice(0, FILENAME_MAX);
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Writes the encrypted payload, then source + job + upload row in one transaction, then enqueues
 * `upload.process` after the commit. The staged file is removed when the transaction fails.
 */
async function stage(
  ctx: ServiceContext,
  input: {
    kind: UploadKind;
    payload: Buffer;
    filename: string | null;
    mimeType: string;
    authorship: Authorship;
  },
): Promise<{ uploadId: string }> {
  const uploadId = randomUUID();
  const path = stagingPathFor(uploadId);
  await mkdir(loadEnv().UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path, encryptBuffer('upload-staging', input.payload), { mode: 0o600 });

  let importJobId: string;
  try {
    importJobId = await withTransaction(async (tx: Tx) => {
      const source = await ensureUploadsSource(ctx, tx);
      const job = await imports.createJob({ userId: ctx.userId, sourceId: source.id, kind: 'upload' }, tx);
      await tx.insert(upload).values({
        id: uploadId,
        userId: ctx.userId,
        sourceId: source.id,
        kind: input.kind,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.payload.length,
        authorship: input.authorship,
        status: 'received',
        importJobId: job.id,
        stagingPath: path,
      });
      return job.id;
    });
  } catch (e) {
    await unlinkQuiet(path).catch(() => undefined);
    throw e;
  }

  await enqueue('upload.process', { userId: ctx.userId, uploadId, importJobId }, { jobId: jobIds.upload(uploadId) });
  return { uploadId };
}

/** FR-024, FR-027, FR-061. Sniffs synchronously: 415 `unsupported_type`, 413 `too_large`; empty is recorded (D-U3). */
export async function createFileUpload(
  ctx: ServiceContext,
  input: { buffer: Buffer; filename: string; authorship?: Authorship },
): Promise<{ uploadId: string }> {
  await imports.assertFiltersConfirmed(ctx.userId);
  const filename = cleanFilename(input.filename);
  const authorship = input.authorship ?? 'authored';
  const sniff = await sniffUpload({ buffer: input.buffer, filename, maxBytes: loadEnv().UPLOAD_MAX_BYTES });

  if (!sniff.ok) {
    if (sniff.reason === 'too_large') throw new AppError('too_large', 'File is too large');
    if (sniff.reason === 'unsupported_type') throw new AppError('unsupported_type', 'Unsupported file type');
    // Zero bytes: recorded as rejected without staging or a job.
    const row = await withTransaction(async (tx) => {
      const source = await ensureUploadsSource(ctx, tx);
      const [inserted] = await tx
        .insert(upload)
        .values({
          userId: ctx.userId,
          sourceId: source.id,
          kind: 'file',
          filename,
          mimeType: null,
          sizeBytes: 0,
          authorship,
          status: 'rejected',
          rejectReason: 'empty',
        })
        .returning({ id: upload.id });
      return inserted;
    });
    if (!row) throw new Error('upload_insert_failed');
    return { uploadId: row.id };
  }

  return stage(ctx, { kind: 'file', payload: input.buffer, filename, mimeType: sniff.mime, authorship });
}

/** FR-025. Notes are staged as the JSON `{text, title?}`, encrypted like files. */
export async function createNote(
  ctx: ServiceContext,
  input: { text: string; title?: string; authorship?: Authorship },
): Promise<{ uploadId: string }> {
  await imports.assertFiltersConfirmed(ctx.userId);
  if (input.text.trim().length === 0 || input.text.length > NOTE_MAX_CHARS) {
    throw new AppError('validation_failed', `Note text must be 1 to ${NOTE_MAX_CHARS} characters`);
  }
  if (input.title !== undefined && input.title.length > NOTE_TITLE_MAX) {
    throw new AppError('validation_failed', `Note title must be at most ${NOTE_TITLE_MAX} characters`);
  }
  const payload = Buffer.from(JSON.stringify({ text: input.text, title: input.title }), 'utf8');
  return stage(ctx, {
    kind: 'note',
    payload,
    filename: null,
    mimeType: 'text/plain',
    authorship: input.authorship ?? 'authored',
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

function toView(row: Upload): UploadView {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    status: row.status,
    rejectReason: row.rejectReason,
    importJobId: row.importJobId,
    contentItemId: row.contentItemId,
    createdAt: row.createdAt.toISOString(),
  };
}

// Cursor is `<createdAt ISO>|<id>` base64url-encoded; newest first, millisecond-truncated (as notifications.list).
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${upload.createdAt})`;

function encodeCursor(row: Upload): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!iso || !id || !z.uuid().safeParse(id).success) return null;
  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

export async function list(
  ctx: ServiceContext,
  q: { cursor?: string; limit: number },
): Promise<{ items: UploadView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit)), 100);
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await getDb()
    .select()
    .from(upload)
    .where(
      and(
        eq(upload.userId, ctx.userId),
        cursor
          ? or(lt(createdAtMs, cursor.createdAt), and(eq(createdAtMs, cursor.createdAt), lt(upload.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(desc(createdAtMs), desc(upload.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(toView), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

async function findOwned(ctx: ServiceContext, id: string, db: DbOrTx = getDb()): Promise<Upload> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  const [row] = await db
    .select()
    .from(upload)
    .where(and(eq(upload.id, id), eq(upload.userId, ctx.userId)))
    .limit(1);
  if (!row) throw new AppError('not_found');
  return row;
}

export async function get(ctx: ServiceContext, id: string): Promise<UploadView> {
  return toView(await findOwned(ctx, id));
}

/**
 * D-U5: a stored upload is removed through a `content_item` deletion request (row deleted in the same
 * transaction); a rejected or failed one is deleted at once; received/processing is a conflict.
 */
export async function remove(ctx: ServiceContext, id: string): Promise<{ deletionRequestId: string | null }> {
  const row = await findOwned(ctx, id);
  if (row.status === 'received' || row.status === 'processing') {
    throw new AppError('conflict', 'The upload is still being processed');
  }
  if (row.status === 'stored' && row.contentItemId) {
    const contentItemId = row.contentItemId;
    const req = await withTransaction(async (tx) => {
      const created = await requestDeletion(
        { userId: ctx.userId, scope: 'content_item', targetId: contentItemId, requestedBy: 'user' },
        tx,
      );
      await tx.delete(upload).where(and(eq(upload.id, row.id), eq(upload.userId, ctx.userId)));
      return created;
    });
    return { deletionRequestId: req.id };
  }
  if (row.stagingPath) await unlinkQuiet(row.stagingPath);
  await getDb()
    .delete(upload)
    .where(and(eq(upload.id, row.id), eq(upload.userId, ctx.userId)));
  return { deletionRequestId: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Worker-facing (upload.process, tmp-sweep)

export async function loadForProcessing(uploadId: string): Promise<(Upload & { userStatus: UserStatus }) | null> {
  const [row] = await getDb()
    .select({ upload, userStatus: user.status })
    .from(upload)
    .innerJoin(user, eq(user.id, upload.userId))
    .where(eq(upload.id, uploadId))
    .limit(1);
  return row ? { ...row.upload, userStatus: row.userStatus } : null;
}

export async function setStatus(
  uploadId: string,
  patch: {
    status: UploadStatus;
    rejectReason?: UploadRejectReason | null;
    contentItemId?: string | null;
    stagingPath?: string | null;
  },
  db: DbOrTx = getDb(),
): Promise<void> {
  await db
    .update(upload)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(upload.id, uploadId));
}

export async function readStaged(stagingPath: string): Promise<Buffer> {
  const ciphertext = await readFile(stagingPath, 'utf8');
  return decryptBuffer('upload-staging', ciphertext);
}

const NOTE_PAYLOAD = z.object({ text: z.string(), title: z.string().optional() });

export function parseNotePayload(buf: Buffer): { text: string; title?: string } {
  const parsed = NOTE_PAYLOAD.parse(JSON.parse(buf.toString('utf8')));
  return parsed.title === undefined ? { text: parsed.text } : { text: parsed.text, title: parsed.title };
}

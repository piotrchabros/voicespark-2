import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb, withTransaction, type DbOrTx, type HubFile, type Tx } from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { HUB_ALLOWED_EXTENSIONS, sniffHubFile } from '@voicespark/integrations/files';
import { loadEnv } from '../../env';
import { AppError, type ServiceContext } from '../../errors';
import { createFsBlobStore } from '../../hub/blob-store';
import { indexTokens } from '../../hub/search-tokens';
import { logger } from '../../logger';
import { enqueue, jobIds } from '../../queues';
import { decryptContent, encryptContent, hubNotFound, inspectFields, type HubKind } from './common';
import { markDirty, syncFieldFor, syncFieldsFor, tombstone, type SyncField } from './sync';

// Files of the Context Hub (US2; contracts/http-api.md "Files (US2)", data-model.md "hub_file" and "Files and blob
// store"; FR-009). Constitution VI exception: the original blob is kept unmodified, encrypted with the `hub-files`
// purpose and readable by its owner only. It is never sent to the AI service or the memory store; only the text the
// `hub.file-extract` worker derives from it is filtered, indexed and synced.

export type ExtractionStatus = HubFile['extractionStatus'];

export interface FileView {
  id: string;
  ownerKind: HubKind;
  ownerId: string;
  name: string;
  description: string | null;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  extractionStatus: ExtractionStatus;
  extractionReason: string | null;
  redactedValues: number;
  createdAt: string;
  updatedAt: string;
  sync: SyncField;
}

export interface FileWriteResult {
  file: FileView;
  sync: SyncField;
  /** Redactions in name and description; present when above zero. */
  redactedValues?: number;
}

export interface UploadInput {
  bytes: Uint8Array;
  filename: string;
  description?: string | null;
}

export interface FilePatchInput {
  name?: string;
  description?: string | null;
}

export interface FileDownload {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Extracted text indexed per file (contracts/hub-search.md). */
export const FILE_INDEX_TEXT_MAX = 90_000;

// 1..255, no `/`, `\` or control chars (contracts/http-api.md).
// eslint-disable-next-line no-control-regex
const NAME_BAD_RE = /[/\\\u0000-\u001f\u007f]/;
const nameField = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((s) => !NAME_BAD_RE.test(s));
const descriptionField = z.string().trim().max(2000).nullable().optional();

const uploadSchema = z.object({ name: nameField, description: descriptionField }).strict();
const patchSchema = z.object({ name: nameField.optional(), description: descriptionField }).strict();

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
    throw new AppError('validation_failed', undefined, { fields });
  }
  return r.data;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function ownerOf(row: HubFile): { kind: HubKind; id: string } {
  if (row.personId) return { kind: 'person', id: row.personId };
  if (row.companyId) return { kind: 'company', id: row.companyId };
  return { kind: 'project', id: row.projectId! };
}

function toView(row: HubFile, sync: SyncField): FileView {
  const owner = ownerOf(row);
  return {
    id: row.id,
    ownerKind: owner.kind,
    ownerId: owner.id,
    name: decryptContent(row.nameEnc),
    description: row.descriptionEnc === null ? null : decryptContent(row.descriptionEnc),
    mimeType: row.mimeType,
    extension: row.extension,
    sizeBytes: row.sizeBytes,
    extractionStatus: row.extractionStatus,
    extractionReason: row.extractionReason,
    redactedValues: row.redactedValues,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sync,
  };
}

async function viewWithSync(ctx: ServiceContext, row: HubFile, db?: DbOrTx): Promise<FileView> {
  return toView(row, await syncFieldFor(ctx.userId, 'file', row.id, db));
}

/**
 * Rewrites the file's blind search row: name, description and, once extracted, the first 90,000 chars of the
 * filtered text (contracts/hub-search.md). Same transaction as the write; also used by the `hub.file-extract` worker.
 */
export async function reindexFile(ctx: ServiceContext, row: HubFile, tx: Tx): Promise<void> {
  const texts = [decryptContent(row.nameEnc)];
  if (row.descriptionEnc !== null) texts.push(decryptContent(row.descriptionEnc));
  if (row.extractionStatus === 'extracted' && row.extractedTextEnc !== null) {
    texts.push(decryptContent(row.extractedTextEnc).slice(0, FILE_INDEX_TEXT_MAX));
  }
  const owner = ownerOf(row);
  await content.upsertSearchDoc(
    ctx,
    {
      itemType: 'file',
      itemId: row.id,
      ownerKind: owner.kind,
      ownerId: owner.id,
      tokens: indexTokens(ctx.userId, texts),
      updatedAt: row.updatedAt,
    },
    tx,
  );
}

async function mustGet(ctx: ServiceContext, fileId: string, db?: DbOrTx): Promise<HubFile> {
  const row = await content.getFile(ctx, fileId, db);
  if (!row) throw hubNotFound();
  return row;
}

/** Name and description through `inspectFields` (FR-028); returns the encrypted columns that were given. */
async function prepareText(
  ctx: ServiceContext,
  fields: { name?: string; description?: string | null },
): Promise<{ nameEnc?: string; descriptionEnc?: string | null; redactedValues: number }> {
  const free: Record<string, string> = {};
  if (fields.name !== undefined) free.name = fields.name;
  if (fields.description) free.description = fields.description;
  const { values, redactedValues } = await inspectFields(ctx, free);
  const out: { nameEnc?: string; descriptionEnc?: string | null; redactedValues: number } = { redactedValues };
  if (values.name !== undefined) out.nameEnc = encryptContent(values.name);
  if (fields.description !== undefined) {
    out.descriptionEnc = values.description ? encryptContent(values.description) : null;
  }
  return out;
}

function withRedacted(result: Omit<FileWriteResult, 'redactedValues'>, redacted: number): FileWriteResult {
  return redacted > 0 ? { ...result, redactedValues: redacted } : result;
}

/**
 * Stores an uploaded file under a record: size (413 `too_large`) and magic-byte (415 `unsupported_type` with
 * `details.allowed`) checks, inspected name and description, the encrypted blob, then the `pending` row with its
 * search row and outbox marks in one transaction, then `hub.file-extract`. The blob is written before the row so the
 * worker never sees a row without one; a failed commit removes it (the daily sweep catches misses).
 */
export async function upload(
  ctx: ServiceContext,
  kind: HubKind,
  recordId: string,
  input: UploadInput,
): Promise<FileWriteResult> {
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  if (bytes.length > loadEnv().HUB_FILE_MAX_BYTES) throw new AppError('too_large');
  const { name, description } = parse(uploadSchema, { name: input.filename, description: input.description });
  const extension = extensionOf(name);
  const sniff = await sniffHubFile(bytes, extension);
  if (!sniff.ok) throw new AppError('unsupported_type', undefined, { allowed: [...HUB_ALLOWED_EXTENSIONS] });
  if (!(await repo.getRecord(ctx, kind, recordId))) throw hubNotFound();
  const prepared = await prepareText(ctx, { name, description: description ?? null });

  const storageKey = randomUUID();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const store = createFsBlobStore();
  const { keyId } = await store.put(ctx.userId, storageKey, bytes);

  let row: HubFile;
  try {
    row = await withTransaction(async (tx) => {
      if (!(await repo.lockRecord(ctx, kind, recordId, tx))) throw hubNotFound();
      const inserted = await content.insertFile(
        ctx,
        { kind, id: recordId },
        {
          nameEnc: prepared.nameEnc!,
          descriptionEnc: prepared.descriptionEnc ?? null,
          mimeType: sniff.mime,
          extension,
          sizeBytes: bytes.length,
          sha256,
          storageKey,
          keyId,
          extractionStatus: 'pending',
        },
        tx,
      );
      await reindexFile(ctx, inserted, tx);
      await markDirty(tx, ctx.userId, 'file', inserted.id);
      await markDirty(tx, ctx.userId, kind, recordId);
      return inserted;
    });
  } catch (err) {
    await store.delete(ctx.userId, storageKey).catch(() => undefined);
    throw err;
  }

  try {
    await enqueue('hub.file-extract', { userId: ctx.userId, fileId: row.id }, { jobId: jobIds.hubFile(row.id) });
  } catch {
    // The row stays `pending`; logged by code only.
    logger.warn({ userId: ctx.userId, entityId: row.id, errorCode: 'hub_file_enqueue_failed' }, 'hub.file-extract not enqueued');
  }
  const file = await viewWithSync(ctx, row);
  return withRedacted({ file, sync: file.sync }, prepared.redactedValues);
}

/** The files of a record, newest change first. 404 for a foreign or missing record. */
export async function list(ctx: ServiceContext, kind: HubKind, recordId: string): Promise<FileView[]> {
  const db = getDb();
  if (!(await repo.getRecord(ctx, kind, recordId, db))) throw hubNotFound();
  const rows = await content.listFilesForOwner(ctx, { kind, id: recordId }, db);
  // One sync-status query for the list, not one per file (SC-002).
  const syncs = await syncFieldsFor(ctx.userId, 'file', rows.map((r) => r.id), db);
  return rows.map((r) => toView(r, syncs.get(r.id)!));
}

export async function get(ctx: ServiceContext, fileId: string): Promise<{ file: FileView; sync: SyncField }> {
  const db = getDb();
  const file = await viewWithSync(ctx, await mustGet(ctx, fileId, db), db);
  return { file, sync: file.sync };
}

/** Renames and/or describes a file (description null clears it). Reindexes and marks the file and owner dirty. */
export async function patch(ctx: ServiceContext, fileId: string, input: FilePatchInput): Promise<FileWriteResult> {
  const fields = parse(patchSchema, input);
  if (fields.name === undefined && fields.description === undefined) {
    throw new AppError('validation_failed', undefined, { fields: [] });
  }
  // Ownership first: a foreign id is 404 before any inspection runs.
  await mustGet(ctx, fileId);
  const prepared = await prepareText(ctx, fields);

  const row = await withTransaction(async (tx) => {
    const { redactedValues: _, ...columns } = prepared;
    const updated = await content.updateFile(ctx, fileId, { ...columns, updatedAt: new Date() }, tx);
    if (!updated) throw hubNotFound();
    await reindexFile(ctx, updated, tx);
    const owner = ownerOf(updated);
    await markDirty(tx, ctx.userId, 'file', fileId);
    await markDirty(tx, ctx.userId, owner.kind, owner.id);
    return updated;
  });
  const file = await viewWithSync(ctx, row);
  return withRedacted({ file, sync: file.sync }, prepared.redactedValues);
}

/**
 * Owner only (FR-009): the row is looked up under the caller's user id, so any other user gets 404. The blob is
 * decrypted here for the download response and goes nowhere else.
 */
export async function download(ctx: ServiceContext, fileId: string): Promise<FileDownload> {
  const row = await mustGet(ctx, fileId);
  const bytes = await createFsBlobStore().get(ctx.userId, row.storageKey);
  return { bytes, filename: decryptContent(row.nameEnc), mimeType: row.mimeType, sizeBytes: row.sizeBytes };
}

/** Row delete, search-row delete, tombstone and owner mark in one transaction; the blob is deleted after commit. */
export async function remove(ctx: ServiceContext, fileId: string): Promise<void> {
  const storageKey = await withTransaction(async (tx) => {
    const row = await mustGet(ctx, fileId, tx);
    const owner = ownerOf(row);
    await tombstone(tx, ctx.userId, 'file', fileId);
    await markDirty(tx, ctx.userId, owner.kind, owner.id);
    await content.deleteSearchDoc(ctx, 'file', fileId, tx);
    if (!(await content.deleteFile(ctx, fileId, tx))) throw hubNotFound();
    return row.storageKey;
  });
  try {
    await createFsBlobStore().delete(ctx.userId, storageKey);
  } catch {
    logger.warn({ userId: ctx.userId, errorCode: 'hub_blob_delete_failed' }, 'hub blob delete failed; sweep will retry');
  }
}

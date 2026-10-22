import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  contentItem,
  contentItemOccurrence,
  getDb,
  importJob,
  withTransaction,
  type ContentKind,
  type Upload,
  type UploadRejectReason,
} from '@voicespark/db';
import { loadEnv } from '@voicespark/core/env';
import { jobLogger, type SafeLogger } from '@voicespark/core/logger';
import type { JobPayload } from '@voicespark/core/queues';
import * as imports from '@voicespark/core/services/imports';
import { inspectForUser } from '@voicespark/core/services/inspection';
import * as profiles from '@voicespark/core/services/profiles';
import * as uploads from '@voicespark/core/services/uploads';
import { buildDocument, type CountCategory, type InspectionResult } from '@voicespark/filters';
import { extractUpload, type UploadMime } from '@voicespark/integrations/files';
import { splitParts } from '@voicespark/integrations/mime';
import { namespaceFor, type MemoryDoc } from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';
import { buildMetadata } from '../import/metadata';

export type UploadOutcome = 'stored' | 'duplicate' | 'rejected' | 'failed' | 'skipped';

export interface UploadResult {
  outcome: UploadOutcome;
  rejectReason?: UploadRejectReason;
}

type UploadJob = Job<JobPayload<'upload.process'>, unknown, 'upload.process'>;
type UploadRow = Upload & { userStatus: string };
type Exclusions = imports.CountsDelta['exclusions'] & {};

const UPLOAD_KINDS_FOR_DEDUP: ContentKind[] = ['file', 'note'];

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Category of a whole-item exclusion: the first whole-item count, else the first count. */
function excludedCategory(r: InspectionResult): CountCategory {
  return r.counts.find((c) => c.wholeItem)?.category ?? r.counts[0]?.category ?? 'inspection_failed';
}

function redactedTotal(r: InspectionResult): number {
  return r.counts.reduce((n, c) => n + c.redactedValues, 0);
}

function addExclusion(e: Exclusions, category: CountCategory, excludedItems: number, redactedValues: number): void {
  const cur = e[category] ?? { excludedItems: 0, redactedValues: 0 };
  e[category] = { excludedItems: cur.excludedItems + excludedItems, redactedValues: cur.redactedValues + redactedValues };
}

async function unlinkQuiet(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

const isMissingFile = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Text and the inspection fields of the staged payload, or the reject reason. */
async function readPayload(
  row: UploadRow,
  buffer: Buffer,
): Promise<{ text: string; title?: string; filename?: string } | { reject: UploadRejectReason }> {
  if (row.kind === 'note') {
    let note: { text: string; title?: string };
    try {
      note = uploads.parseNotePayload(buffer);
    } catch {
      return { reject: 'corrupt' };
    }
    if (!note.text.trim()) return { reject: 'empty' };
    return note.title !== undefined && note.title.trim() ? { text: note.text, title: note.title } : { text: note.text };
  }
  const filename = row.filename ?? 'upload';
  if (!row.mimeType) return { reject: 'unsupported_type' };
  const extracted = await extractUpload({
    buffer,
    mime: row.mimeType as UploadMime,
    filename,
    maxBytes: loadEnv().UPLOAD_MAX_BYTES,
  });
  return 'reject' in extracted ? extracted : { text: extracted.text, filename };
}

/**
 * `upload.process` (T110, jobs.md behavior 3): decrypt the staged payload, extract, dedup by content hash (D-U4),
 * inspect every part (D-U6), then `content_item(pending_write)` -> `addDocuments` -> `active`. Content reaches the
 * store only as `buildDocument()` output of an accepted inspection (constitution I). A store failure keeps the staged
 * file for the retry; every terminal outcome removes it.
 */
export function createUploadHandler(overrides: Partial<WorkerDeps> = {}): Handler<'upload.process'> {
  let deps: WorkerDeps | undefined;
  return async (job) => {
    deps ??= defaultDeps(overrides);
    return runUpload(job, deps);
  };
}

async function runUpload(job: UploadJob, deps: WorkerDeps): Promise<UploadResult> {
  const { userId, uploadId, importJobId } = job.data;
  const log = jobLogger(job.id ?? uploadId, { uploadId, importJobId });

  const row = await uploads.loadForProcessing(uploadId);
  if (
    !row ||
    row.userId !== userId ||
    row.importJobId !== importJobId ||
    (row.status !== 'received' && row.status !== 'processing')
  ) {
    return { outcome: 'skipped' };
  }

  try {
    if (row.userStatus !== 'active') return await fail(row, 'user_inactive', log);
    if (!row.stagingPath) return await fail(row, 'staging_missing', log);

    await uploads.setStatus(uploadId, { status: 'processing' });
    await imports.setRunning(importJobId);

    let buffer: Buffer;
    try {
      buffer = await uploads.readStaged(row.stagingPath);
    } catch (e) {
      if (isMissingFile(e)) return await fail(row, 'staging_missing', log);
      throw e;
    }

    const payload = await readPayload(row, buffer);
    if ('reject' in payload) {
      return await reject(row, payload.reject, { counters: { itemsProcessed: 1, itemsSkipped: 0 } }, log);
    }

    const { contentHash } = imports.hashes({
      subject: payload.title ?? payload.filename ?? '',
      bodyText: payload.text,
    });
    const existing = await findActiveItem(userId, contentHash);
    if (existing) {
      await finish(row, { status: 'stored', contentItemId: existing }, { itemsProcessed: 1, itemsDuplicate: 1 }, log);
      return { outcome: 'duplicate' };
    }

    return await store(row, payload, contentHash, deps, log);
  } catch (err) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (finalAttempt) {
      await fail(row, 'upload_failed', log).catch(() => undefined);
    } else {
      log.warn({ status: 'retry', errorCode: 'upload_error', attempt: job.attemptsMade + 1 });
    }
    throw err;
  }
}

/** An active top-level upload/note item of the user with the same content hash (D-U4). */
async function findActiveItem(userId: string, contentHash: string): Promise<string | null> {
  const [hit] = await getDb()
    .select({ id: contentItem.id })
    .from(contentItem)
    .where(
      and(
        eq(contentItem.userId, userId),
        eq(contentItem.contentHash, contentHash),
        inArray(contentItem.kind, UPLOAD_KINDS_FOR_DEDUP),
        eq(contentItem.status, 'active'),
        isNull(contentItem.parentItemId),
      ),
    )
    .limit(1);
  return hit?.id ?? null;
}

/**
 * Items left by an earlier attempt of this upload (same occurrence ref). An active one means the previous run died
 * after the write; a `pending_write` one is removed (with its documents, best effort) so the retry starts clean.
 */
async function leftoverItem(row: UploadRow, providerRef: string, deps: WorkerDeps): Promise<string | null> {
  const [hit] = await getDb()
    .select({ id: contentItem.id, status: contentItem.status })
    .from(contentItemOccurrence)
    .innerJoin(contentItem, eq(contentItem.id, contentItemOccurrence.contentItemId))
    .where(and(eq(contentItemOccurrence.sourceId, row.sourceId), eq(contentItemOccurrence.providerRef, providerRef)))
    .limit(1);
  if (!hit) return null;
  if (hit.status === 'active') return hit.id;
  const children = await getDb()
    .select({ id: contentItem.id })
    .from(contentItem)
    .where(eq(contentItem.parentItemId, hit.id));
  const ids = [hit.id, ...children.map((c) => c.id)];
  await deps.store.deleteDocuments(namespaceFor(row.userId), ids).catch(() => undefined);
  await getDb().delete(contentItem).where(inArray(contentItem.id, ids));
  return null;
}

async function store(
  row: UploadRow,
  payload: { text: string; title?: string; filename?: string },
  contentHash: string,
  deps: WorkerDeps,
  log: SafeLogger,
): Promise<UploadResult> {
  const providerRef = `upload-${row.id}`;
  const resumed = await leftoverItem(row, providerRef, deps);
  if (resumed) {
    await finish(row, { status: 'stored', contentItemId: resumed }, { itemsProcessed: 1, itemsImported: 1 }, log);
    return { outcome: 'stored' };
  }

  const kind: ContentKind = row.kind === 'note' ? 'note' : 'file';
  const parts = splitParts(payload.text);
  if (parts.length === 0) return reject(row, 'empty', { counters: { itemsProcessed: 1, itemsSkipped: 0 } }, log);

  const results: InspectionResult[] = [];
  for (const part of parts) {
    const result = await inspectForUser(
      row.userId,
      {
        kind,
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.filename !== undefined ? { filename: payload.filename } : {}),
        bodyText: part,
        headers: {},
        folders: [],
      },
      { classifier: deps.classifier },
    );
    // Fail closed: any excluded part (including inspection_failed) rejects the whole upload.
    if (result.outcome !== 'accepted' || result.text === undefined) {
      const exclusions: Exclusions = {};
      addExclusion(exclusions, excludedCategory(result), 1, redactedTotal(result));
      return reject(
        row,
        'sensitive_content',
        { counters: { itemsProcessed: 1, itemsExcluded: 1 }, exclusions },
        log,
      );
    }
    results.push(result);
  }

  const [job] = await getDb()
    .select({ filterPolicyVersion: importJob.filterPolicyVersion })
    .from(importJob)
    .where(eq(importJob.id, row.importJobId!))
    .limit(1);
  const filterPolicyVersion = job?.filterPolicyVersion ?? 0;
  const itemDate = row.createdAt;
  const parentId = randomUUID();
  const items = results.map((result, i) => ({
    id: i === 0 ? parentId : randomUUID(),
    parentItemId: i === 0 ? null : parentId,
    part: parts.length > 1 ? i + 1 : undefined,
    result,
    contentHash: i === 0 ? contentHash : imports.hashes({ bodyText: parts[i]! }).contentHash,
  }));

  const docs: MemoryDoc[] = items.map((it) => ({
    id: it.id,
    content: buildDocument(it.result, {
      kind,
      date: itemDate.toISOString(),
      ...(it.result.fields?.title !== undefined ? { title: it.result.fields.title } : {}),
      ...(it.result.fields?.filename !== undefined ? { filename: it.result.fields.filename } : {}),
    }),
    documentDate: itemDate.toISOString(),
    metadata: buildMetadata({
      kind,
      authorship: row.authorship,
      contentItemId: it.id,
      ...(it.parentItemId !== null ? { parentItemId: it.parentItemId } : {}),
      sourceId: row.sourceId,
      itemDate,
      ...(it.result.languageHint ? { lang: it.result.languageHint } : {}),
      wordCount: wordCount(it.result.text ?? ''),
      filterPolicyVersion,
      ...(it.part !== undefined ? { part: it.part } : {}),
      folders: [],
    }),
  }));

  await withTransaction(async (tx) => {
    await tx.insert(contentItem).values(
      items.map((it) => ({
        id: it.id,
        userId: row.userId,
        kind,
        parentItemId: it.parentItemId,
        authorship: row.authorship,
        itemDate,
        languageCode: it.result.languageHint?.slice(0, 8) ?? null,
        wordCount: wordCount(it.result.text ?? ''),
        messageIdHash: null,
        contentHash: it.contentHash,
        filterPolicyVersion,
        redactedValues: redactedTotal(it.result),
        status: 'pending_write' as const,
      })),
    );
    await imports.insertOccurrence(tx, {
      contentItemId: parentId,
      sourceId: row.sourceId,
      providerRef,
      folders: [],
      isSent: row.authorship === 'authored',
      importJobId: row.importJobId!,
    });
  });

  const ids = items.map((it) => it.id);
  try {
    await deps.store.addDocuments(namespaceFor(row.userId), docs);
  } catch (err) {
    // Nothing half-written survives (the occurrence cascades); the staged file stays for the retry.
    await getDb().delete(contentItem).where(inArray(contentItem.id, ids));
    throw err;
  }
  await getDb()
    .update(contentItem)
    .set({ status: 'active' })
    .where(and(inArray(contentItem.id, ids), eq(contentItem.status, 'pending_write')));

  const exclusions: Exclusions = {};
  for (const it of items) {
    for (const c of it.result.counts) if (c.redactedValues > 0) addExclusion(exclusions, c.category, 0, c.redactedValues);
  }
  const redacted = Object.keys(exclusions).length > 0;
  await finish(
    row,
    { status: 'stored', contentItemId: parentId },
    { itemsProcessed: 1, itemsImported: 1, ...(redacted ? { itemsRedacted: 1 } : {}) },
    log,
    exclusions,
  );

  // T121: first-time automatic profile generation; best effort, never fails the upload.
  try {
    await profiles.autoGenerateIfFirstEligible(row.userId);
  } catch (e) {
    log.warn({ errorCode: (e as { code?: string } | null)?.code ?? 'auto_generate_failed' });
  }
  return { outcome: 'stored' };
}

/** Terminal success-side outcome: status + counts in one transaction, staged file removed, job completed. */
async function finish(
  row: UploadRow,
  patch: { status: 'stored' | 'rejected'; contentItemId?: string; rejectReason?: UploadRejectReason },
  counters: imports.CountsDelta['counters'],
  log: SafeLogger,
  exclusions?: Exclusions,
): Promise<void> {
  await withTransaction(async (tx) => {
    await uploads.setStatus(row.id, { ...patch, stagingPath: null }, tx);
    await imports.recordCounts(row.importJobId!, row.userId, { counters, ...(exclusions ? { exclusions } : {}) }, tx);
  });
  await unlinkQuiet(row.stagingPath);
  await imports.complete(row.importJobId!);
  log.info({ status: patch.status, ...(patch.rejectReason ? { errorCode: patch.rejectReason } : {}) });
}

async function reject(
  row: UploadRow,
  reason: UploadRejectReason,
  delta: imports.CountsDelta,
  log: SafeLogger,
): Promise<UploadResult> {
  await finish(row, { status: 'rejected', rejectReason: reason }, delta.counters, log, delta.exclusions);
  return { outcome: 'rejected', rejectReason: reason };
}

async function fail(row: UploadRow, errorCode: string, log: SafeLogger): Promise<UploadResult> {
  await uploads.setStatus(row.id, { status: 'failed', stagingPath: null });
  await imports.failJob(row.importJobId!, errorCode);
  await unlinkQuiet(row.stagingPath);
  log.warn({ status: 'failed', errorCode });
  return { outcome: 'failed' };
}

export const handlers: HandlerMap = {
  'upload.process': createUploadHandler(),
};

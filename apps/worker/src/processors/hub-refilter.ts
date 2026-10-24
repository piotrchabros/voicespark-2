import type { Job } from 'bullmq';
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import {
  getDb,
  hubFile,
  hubNote,
  hubSyncItem,
  hubThread,
  hubThreadRecord,
  user,
  withTransaction,
  type HubFile,
  type HubNote,
  type HubSyncEntity,
  type Tx,
} from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import * as recordRepo from '@voicespark/db/repos/user/hub-records';
import * as syncRepo from '@voicespark/db/repos/user/hub-sync';
import type { ServiceContext } from '@voicespark/core/errors';
import {
  noteTextSegments,
  noteToPlainText,
  rebuildNoteDoc,
  type HubNode,
  type HubNoteDoc,
} from '@voicespark/core/hub/content-schema';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import { jobLogger, logger } from '@voicespark/core/logger';
import { enqueue, jobIds, type JobPayload } from '@voicespark/core/queues';
import { audit } from '@voicespark/core/services/audit';
import { decryptContent, encryptContent, type HubKind } from '@voicespark/core/services/hub/common';
import { reindexFile } from '@voicespark/core/services/hub/files';
import { reindex as reindexRecord } from '@voicespark/core/services/hub/records';
import { docIdFor } from '@voicespark/core/services/hub/sync';
import { inspectForUser, loadOwnAddresses, loadPolicy } from '@voicespark/core/services/inspection';
import { notify } from '@voicespark/core/services/notifications';
import { inspectSegments, type Classifier, type InspectionResult, type Policy } from '@voicespark/filters';
import { HUB_TEXT_MAX_CHARS } from '@voicespark/integrations/files';
import { namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';

// `hub.refilter` (T084, contracts/jobs.md (15); data-model.md "Filter-preference change"; FR-028, constitution VI).
// Re-inspects the stored summaries, note bodies, extracted file text and record free-text fields under the user's
// current policy, re-encrypts and re-indexes what changed and marks every sync item dirty, so `hub.sync` rebuilds the
// memory documents (contact fields follow the new policy at that build). Items are written only when their filtered
// text changed, so a re-run for the same policy version is a no-op apart from the dirty marks.
//
// Fail-closed: `inspection_failed` is a retryable failure, never an exclusion. While attempts remain the job throws.
// After the last attempt the items it could not re-inspect (and the records whose documents embed them) are held:
// their memory documents are deleted, their sync rows stay `pending` with `last_error_code = refilter_pending` and are
// not due, their app rows and search rows are left as they are, and the user is notified. The daily
// `maintenance.hub-refilter-retry` re-enqueues the job for users with held rows.

export type HubRefilterOutcome = 'refiltered' | 'refilter_pending' | 'skipped';

export interface HubRefilterResult {
  outcome: HubRefilterOutcome;
  /** Held items (final failure only). */
  pending?: number;
}

/** Body of a note whose whole content the new policy excludes. Notes are never deleted by the job. */
export const REFILTER_NOTE_PLACEHOLDER = 'This note was hidden because it matches your content filter settings.';

export const REFILTER_PENDING = 'refilter_pending';

type RefilterJob = Job<JobPayload<'hub.refilter'>, unknown, 'hub.refilter'>;

interface Target {
  entityType: HubSyncEntity;
  entityId: string;
}

interface Env {
  ctx: ServiceContext;
  policy: Policy;
  ownAddresses: string[];
  classifier: Classifier;
  failed: Target[];
}

type Inspected =
  | { status: 'accepted'; values: string[]; redactedValues: number }
  | { status: 'excluded'; category: string }
  | { status: 'failed' };

const INSPECTION_FAILED = 'inspection_failed';
const BATCH = 100;
const DELETE_CHUNK_SIZE = 100;
const WAKE_DELAY_MS = 2000;
// Held rows are never due: `hub.sync` claims only rows with `next_attempt_at <= now()`.
const HOLD_UNTIL = sql`now() + interval '100 years'`;
const HREF_RE = /^(https?|mailto):/i;

const RECORD_FIELDS = {
  person: ['roleTitleEnc', 'descriptionEnc'],
  company: ['industryEnc', 'descriptionEnc'],
  project: ['descriptionEnc'],
} as const satisfies Record<HubKind, readonly string[]>;

const KINDS: readonly HubKind[] = ['person', 'company', 'project'];

export function createHubRefilterHandler(overrides: Partial<WorkerDeps> = {}): Handler<'hub.refilter'> {
  let deps: WorkerDeps | undefined;
  return async (job) => {
    deps ??= defaultDeps(overrides);
    return runRefilter(job, deps);
  };
}

async function userActive(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.status === 'active';
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One `inspectSegments` pass under the loaded policy. Any failure to inspect is `failed`, never `excluded`. */
async function inspectTexts(env: Env, texts: string[]): Promise<Inspected> {
  try {
    const r = await inspectSegments(texts, env.policy, { classifier: env.classifier });
    if (r.excluded) return r.category === INSPECTION_FAILED ? { status: 'failed' } : { status: 'excluded', category: r.category };
    return { status: 'accepted', values: r.segments.map((s) => s as string), redactedValues: r.redactedValues };
  } catch {
    return { status: 'failed' };
  }
}

async function runRefilter(job: RefilterJob, deps: WorkerDeps): Promise<HubRefilterResult> {
  const { userId, policyVersion } = job.data;
  const log = jobLogger(job.id ?? userId, { userId });
  if (!(await userActive(userId))) {
    log.info({ status: 'skipped' });
    return { outcome: 'skipped' };
  }
  const { policy, version } = await loadPolicy(userId);
  // A newer version has its own job, which re-inspects everything under the newer policy.
  if (policyVersion < version) {
    log.info({ status: 'skipped', errorCode: 'stale_policy_version' });
    return { outcome: 'skipped' };
  }

  const env: Env = {
    ctx: { userId, role: 'user' },
    policy,
    ownAddresses: await loadOwnAddresses(userId),
    classifier: deps.classifier,
    failed: [],
  };
  await refilterRecords(env);
  await refilterNotes(env);
  await refilterFiles(env);
  await refilterSummaries(env);

  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  if (env.failed.length > 0 && !finalAttempt) {
    log.warn({ status: 'retry', errorCode: INSPECTION_FAILED, attempt: job.attemptsMade + 1, count: env.failed.length });
    throw new Error(INSPECTION_FAILED);
  }

  const held = env.failed.length > 0 ? await withEmbeddingRecords(env) : [];
  const heldDocIds = held.map((t) => docIdFor(t.entityType, t.entityId));
  await withTransaction(async (tx) => {
    await syncRepo.backfillAndBump({ userId }, tx);
    if (held.length > 0) await hold(tx, userId, held);
    await release(tx, userId, heldDocIds);
  });
  await wakeSync(userId);

  if (held.length === 0) {
    log.info({ status: 'refiltered' });
    return { outcome: 'refiltered' };
  }
  await deleteDocuments(deps.store, namespaceFor(userId), heldDocIds);
  await notify(userId, 'hub_refilter_pending', { items: held.length });
  log.warn({ status: REFILTER_PENDING, errorCode: INSPECTION_FAILED, count: held.length });
  return { outcome: 'refilter_pending', pending: held.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Records: free-text fields (role or title, industry, description). Names and contact fields are not re-inspected
// here; contact fields follow the policy when the memory document is built.

async function refilterRecords(env: Env): Promise<void> {
  for (const kind of KINDS) {
    const ids = (await recordRepo.listForSort(env.ctx, kind)).map((r) => r.id);
    for (const batch of chunks(ids, BATCH)) {
      for (const row of await recordRepo.getRecordsByIds(env.ctx, kind, batch)) await refilterRecord(env, kind, row);
    }
  }
}

async function refilterRecord(env: Env, kind: HubKind, row: recordRepo.HubRecordRow): Promise<void> {
  const columns = row as unknown as Record<string, string | null>;
  const fields = RECORD_FIELDS[kind].filter((f) => columns[f] !== null);
  if (fields.length === 0) return;
  const before = fields.map((f) => decryptContent(columns[f]!));
  const r = await inspectTexts(env, before);
  if (r.status === 'failed') {
    env.failed.push({ entityType: kind, entityId: row.id });
    return;
  }
  // A wholly excluded set clears the fields; the record itself stays.
  const after = r.status === 'excluded' ? fields.map(() => null) : r.values;
  if (after.every((v, i) => v === before[i])) return;

  await withTransaction(async (tx) => {
    const locked = await recordRepo.lockRecord(env.ctx, kind, row.id, tx);
    // Gone or changed meanwhile: that write was inspected under the current policy.
    if (!locked || fields.some((f) => (locked as unknown as Record<string, string | null>)[f] !== columns[f])) return;
    const patch: Record<string, string | null> = {};
    fields.forEach((f, i) => {
      patch[f] = after[i] === null ? null : encryptContent(after[i]!);
    });
    const updated = await recordRepo.updateRecord(env.ctx, kind, row.id, patch, tx);
    if (updated) await reindexRecord(env.ctx, kind, updated, tx);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Notes: title, text nodes and hrefs in one pass, as on a write.

function noteOwner(row: HubNote): { kind: HubKind; id: string } {
  if (row.personId) return { kind: 'person', id: row.personId };
  if (row.companyId) return { kind: 'company', id: row.companyId };
  return { kind: 'project', id: row.projectId! };
}

/** A link whose href was redacted away is no longer a link (same rule as the note service). */
function dropBrokenLinks(doc: HubNoteDoc): HubNoteDoc {
  const visit = (n: HubNode) => {
    if (n.marks) {
      n.marks = n.marks.filter((m) => m.type !== 'link' || HREF_RE.test(m.attrs?.href ?? ''));
      if (n.marks.length === 0) delete n.marks;
    }
    for (const c of n.content ?? []) visit(c);
  };
  for (const c of doc.content) visit(c);
  return doc;
}

function placeholderDoc(): HubNoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: REFILTER_NOTE_PLACEHOLDER }] }] };
}

async function refilterNotes(env: Env): Promise<void> {
  const ids = await getDb().select({ id: hubNote.id }).from(hubNote).where(eq(hubNote.userId, env.ctx.userId));
  for (const batch of chunks(ids.map((r) => r.id), BATCH)) {
    for (const row of await content.getNotesByIds(env.ctx, batch)) await refilterNote(env, row);
  }
}

async function refilterNote(env: Env, row: HubNote): Promise<void> {
  const title = decryptContent(row.titleEnc);
  const body = JSON.parse(decryptContent(row.bodyJsonEnc)) as HubNoteDoc;
  const segments = noteTextSegments(body);
  const texts = [title, ...segments.map((s) => s.value)];
  const r = await inspectTexts(env, texts);
  if (r.status === 'failed') {
    env.failed.push({ entityType: 'note', entityId: row.id });
    return;
  }

  let next: { title: string; body: HubNoteDoc; redactedValues: number };
  if (r.status === 'excluded') {
    // Every non-empty text of the note is withheld.
    const removed = texts.filter((t) => t.trim() !== '').length;
    next = { title: '', body: placeholderDoc(), redactedValues: row.redactedValues + removed };
  } else {
    next = {
      title: r.values[0]!,
      body: dropBrokenLinks(rebuildNoteDoc(body, r.values.slice(1))),
      redactedValues: row.redactedValues + r.redactedValues,
    };
  }
  if (next.title === title && JSON.stringify(next.body) === JSON.stringify(body)) return;

  await withTransaction(async (tx) => {
    const [locked] = await tx
      .select({ titleEnc: hubNote.titleEnc, bodyJsonEnc: hubNote.bodyJsonEnc })
      .from(hubNote)
      .where(and(eq(hubNote.id, row.id), eq(hubNote.userId, env.ctx.userId)))
      .for('update');
    if (!locked || locked.titleEnc !== row.titleEnc || locked.bodyJsonEnc !== row.bodyJsonEnc) return;
    const updated = await content.updateNote(
      env.ctx,
      row.id,
      {
        titleEnc: encryptContent(next.title),
        bodyJsonEnc: encryptContent(JSON.stringify(next.body)),
        redactedValues: next.redactedValues,
        updatedAt: new Date(),
      },
      tx,
    );
    if (!updated) return;
    const owner = noteOwner(updated);
    await content.upsertSearchDoc(
      env.ctx,
      {
        itemType: 'note',
        itemId: updated.id,
        ownerKind: owner.kind,
        ownerId: owner.id,
        tokens: indexTokens(env.ctx.userId, [next.title, noteToPlainText(next.body)].filter(Boolean)),
        updatedAt: updated.updatedAt,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Files: the extracted text, inspected like `hub.file-extract` does. The blob is never read.

function fileOwner(row: HubFile): { kind: HubKind; id: string } {
  if (row.personId) return { kind: 'person', id: row.personId };
  if (row.companyId) return { kind: 'company', id: row.companyId };
  return { kind: 'project', id: row.projectId! };
}

/** Category of a whole-item exclusion: the first whole-item count, else the first count. */
function excludedCategory(r: InspectionResult): string {
  return r.counts.find((c) => c.wholeItem)?.category ?? r.counts[0]?.category ?? INSPECTION_FAILED;
}

async function refilterFiles(env: Env): Promise<void> {
  const ids = await getDb()
    .select({ id: hubFile.id })
    .from(hubFile)
    .where(
      and(eq(hubFile.userId, env.ctx.userId), eq(hubFile.extractionStatus, 'extracted'), isNotNull(hubFile.extractedTextEnc)),
    );
  for (const batch of chunks(ids.map((r) => r.id), BATCH)) {
    for (const row of await content.getFilesByIds(env.ctx, batch)) await refilterFile(env, row);
  }
}

async function refilterFile(env: Env, row: HubFile): Promise<void> {
  if (row.extractionStatus !== 'extracted' || row.extractedTextEnc === null) return;
  const text = decryptContent(row.extractedTextEnc);
  const result = await inspectForUser(
    env.ctx.userId,
    { kind: 'file', bodyText: text, headers: {}, folders: [] },
    { policy: env.policy, ownAddresses: env.ownAddresses, classifier: env.classifier },
  );
  const category = result.outcome === 'accepted' ? null : excludedCategory(result);
  if (category === INSPECTION_FAILED || (result.outcome === 'accepted' && result.text === undefined)) {
    env.failed.push({ entityType: 'file', entityId: row.id });
    return;
  }

  let set: content.HubFilePatch;
  if (category !== null) {
    // Whole-item exclusion: the derived text is discarded; the blob stays (constitution VI exception).
    set = { extractionStatus: 'excluded', extractionReason: category, extractedTextEnc: null };
  } else {
    const next = result.text!.slice(0, HUB_TEXT_MAX_CHARS);
    if (next === text) return;
    const redacted = result.counts.reduce((n, c) => n + c.redactedValues, 0);
    set = { extractedTextEnc: encryptContent(next), redactedValues: row.redactedValues + redacted };
  }

  await withTransaction(async (tx) => {
    const [locked] = await tx
      .select({ extractedTextEnc: hubFile.extractedTextEnc })
      .from(hubFile)
      .where(and(eq(hubFile.id, row.id), eq(hubFile.userId, env.ctx.userId)))
      .for('update');
    if (!locked || locked.extractedTextEnc !== row.extractedTextEnc) return;
    const updated = await content.updateFile(env.ctx, row.id, { ...set, updatedAt: new Date() }, tx);
    if (!updated) return;
    await reindexFile(env.ctx, updated, tx);
    if (category !== null) {
      await audit.record(
        {
          actorType: 'system',
          actorUserId: env.ctx.userId,
          action: 'hub.file_excluded',
          targetType: 'hub_file',
          targetId: row.id,
          metadata: { category },
        },
        tx,
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Summaries: summary and subject of summarised threads. A wholly excluded summary is cleared; `hub.sync` then
// removes its document. Threads have no search row.

async function refilterSummaries(env: Env): Promise<void> {
  const threads = await getDb()
    .select({ id: hubThread.id, subjectEnc: hubThread.subjectEnc, summaryEnc: hubThread.summaryEnc })
    .from(hubThread)
    .where(and(eq(hubThread.userId, env.ctx.userId), isNotNull(hubThread.summaryEnc)));
  for (const t of threads) await refilterSummary(env, t);
}

async function refilterSummary(
  env: Env,
  t: { id: string; subjectEnc: string | null; summaryEnc: string | null },
): Promise<void> {
  if (t.summaryEnc === null) return;
  const before = [decryptContent(t.summaryEnc), ...(t.subjectEnc === null ? [] : [decryptContent(t.subjectEnc)])];
  const r = await inspectTexts(env, before);
  if (r.status === 'failed') {
    env.failed.push({ entityType: 'summary', entityId: t.id });
    return;
  }
  if (r.status === 'accepted' && r.values.every((v, i) => v === before[i])) return;
  const set =
    r.status === 'excluded'
      ? { summaryEnc: null, summaryUpdatedAt: new Date() }
      : {
          summaryEnc: encryptContent(r.values[0]!),
          ...(t.subjectEnc === null ? {} : { subjectEnc: encryptContent(r.values[1]!) }),
          summaryUpdatedAt: new Date(),
        };

  await withTransaction(async (tx) => {
    const [locked] = await tx
      .select({ summaryEnc: hubThread.summaryEnc, subjectEnc: hubThread.subjectEnc })
      .from(hubThread)
      .where(and(eq(hubThread.id, t.id), eq(hubThread.userId, env.ctx.userId)))
      .for('update');
    if (!locked || locked.summaryEnc !== t.summaryEnc || locked.subjectEnc !== t.subjectEnc) return;
    await tx
      .update(hubThread)
      .set(set)
      .where(and(eq(hubThread.id, t.id), eq(hubThread.userId, env.ctx.userId)));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Final failure

/**
 * The failed items plus the records whose memory documents embed them: the owner of a note or file and the records
 * a summary is attached to. Rebuilding those documents would carry text filtered under the old policy.
 */
async function withEmbeddingRecords(env: Env): Promise<Target[]> {
  const out = new Map<string, Target>();
  const add = (t: Target) => out.set(docIdFor(t.entityType, t.entityId), t);
  env.failed.forEach(add);

  const noteIds = env.failed.filter((t) => t.entityType === 'note').map((t) => t.entityId);
  for (const row of await content.getNotesByIds(env.ctx, noteIds)) {
    const o = noteOwner(row);
    add({ entityType: o.kind, entityId: o.id });
  }
  const fileIds = env.failed.filter((t) => t.entityType === 'file').map((t) => t.entityId);
  for (const row of await content.getFilesByIds(env.ctx, fileIds)) {
    const o = fileOwner(row);
    add({ entityType: o.kind, entityId: o.id });
  }
  const threadIds = env.failed.filter((t) => t.entityType === 'summary').map((t) => t.entityId);
  if (threadIds.length > 0) {
    const attached = await getDb()
      .select({ personId: hubThreadRecord.personId, companyId: hubThreadRecord.companyId, projectId: hubThreadRecord.projectId })
      .from(hubThreadRecord)
      .where(and(eq(hubThreadRecord.userId, env.ctx.userId), inArray(hubThreadRecord.threadId, threadIds)));
    for (const a of attached) {
      if (a.personId) add({ entityType: 'person', entityId: a.personId });
      if (a.companyId) add({ entityType: 'company', entityId: a.companyId });
      if (a.projectId) add({ entityType: 'project', entityId: a.projectId });
    }
  }
  return [...out.values()];
}

/**
 * Held rows: `pending`, `refilter_pending`, never due, lease dropped. The version bump keeps an in-flight `hub.sync`
 * write from completing the row as `stored`. Rows are created for items that were never marked.
 */
async function hold(tx: Tx, userId: string, targets: Target[]): Promise<void> {
  await tx
    .insert(hubSyncItem)
    .values(
      targets.map((t) => ({
        userId,
        entityType: t.entityType,
        entityId: t.entityId,
        docId: docIdFor(t.entityType, t.entityId),
        lastErrorCode: REFILTER_PENDING,
        nextAttemptAt: HOLD_UNTIL,
      })),
    )
    .onConflictDoUpdate({
      target: [hubSyncItem.userId, hubSyncItem.docId],
      set: {
        version: sql`${hubSyncItem.version} + 1`,
        status: 'pending',
        attempts: 0,
        lastErrorCode: REFILTER_PENDING,
        nextAttemptAt: HOLD_UNTIL,
        leaseUntil: null,
        updatedAt: sql`now()`,
      },
    });
}

/** Rows held by an earlier run that this run re-inspected: the bump already made them due. */
async function release(tx: Tx, userId: string, heldDocIds: string[]): Promise<void> {
  await tx
    .update(hubSyncItem)
    .set({ lastErrorCode: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(hubSyncItem.userId, userId),
        eq(hubSyncItem.lastErrorCode, REFILTER_PENDING),
        ...(heldDocIds.length > 0 ? [notInArray(hubSyncItem.docId, heldDocIds)] : []),
      ),
    );
}

/** One `hub.sync` per user after the commit. A Redis failure is recovered by `maintenance.hub-sync-sweep`. */
async function wakeSync(userId: string): Promise<void> {
  try {
    await enqueue('hub.sync', { userId }, { jobId: jobIds.hubSync(userId), delay: WAKE_DELAY_MS });
  } catch {
    logger.warn({ userId, errorCode: 'hub_sync_enqueue_failed' }, 'hub.sync wake-up not enqueued; sweep will retry');
  }
}

/** Chunks of 100; failed ids are retried once, then the job fails (the held rows keep the retry scheduled). */
async function deleteDocuments(store: MemoryStore, ns: string, ids: string[]): Promise<void> {
  for (const chunk of chunks(ids, DELETE_CHUNK_SIZE)) {
    const first = await store.deleteDocuments(ns, chunk);
    if (first.errors.length === 0) continue;
    const retry = await store.deleteDocuments(
      ns,
      first.errors.map((e) => e.id),
    );
    if (retry.errors.length > 0) throw new Error('supermemory_delete_failed');
  }
}

export const handlers: HandlerMap = {
  'hub.refilter': createHubRefilterHandler(),
};

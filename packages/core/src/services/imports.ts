import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  connectedSource,
  contentItem,
  contentItemOccurrence,
  exclusionRecord,
  filterPreferences,
  getDb,
  importItemFailure,
  importJob,
  skipRecord,
  SKIP_REASONS,
  syncCursor,
  withTransaction,
  type DbOrTx,
  type ImportJobKind,
  type ImportJobStatus,
  type ImportPauseReason,
  type ItemFailureReason,
  type SkipReason,
  type Tx,
} from '@voicespark/db';
import { FILTER_CATEGORIES as CATEGORY_DEFS, labelFor, type CountCategory } from '@voicespark/filters';
import type { FolderCursor, FolderState, InitialCheckpoint } from '@voicespark/integrations/mail';
import { hmacHex } from '../crypto';
import { AppError, type ServiceContext } from '../errors';
import { enqueue, getRedisConnection, jobIds } from '../queues';
import { notify } from './notifications';

export type ImportJobRow = typeof importJob.$inferSelect;

export interface ImportProgress {
  id: string;
  kind: ImportJobKind;
  status: ImportJobStatus;
  pauseReason: ImportPauseReason | null;
  itemsDiscovered: number;
  itemsProcessed: number;
  itemsImported: number;
  itemsDuplicate: number;
  itemsExcluded: number;
  itemsSkipped: number;
  itemsFailed: number;
  totalEstimate: number | null;
  remainingEstimate: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
}

export type ImportCounter =
  | 'itemsDiscovered'
  | 'itemsProcessed'
  | 'itemsImported'
  | 'itemsDuplicate'
  | 'itemsExcluded'
  | 'itemsRedacted'
  | 'itemsSkipped'
  | 'itemsFailed';

export interface CountsDelta {
  counters?: Partial<Record<ImportCounter, number>>;
  exclusions?: Partial<Record<CountCategory, { excludedItems: number; redactedValues: number }>>;
  skips?: Partial<Record<SkipReason, number>>;
}

export interface ExclusionSummary {
  importJobId: string;
  categories: { key: string; label: string; excludedItems: number; redactedValues: number }[];
  skipped: { reason: SkipReason; count: number }[];
}

export const NON_TERMINAL_STATUSES = ['queued', 'running', 'paused'] as const satisfies readonly ImportJobStatus[];
/** Redis lock ttl for "one page in flight per source" (D-C6). */
export const SOURCE_LOCK_TTL_MS = 300_000;
const RECENT_IMPORTS_LIMIT = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------------------
// Hashes (FR-014). All via the DEDUP_HMAC_KEY.

/** Whitespace-normalized dedup hashes; `messageIdHash` is null when the message has no Message-ID. */
export function hashes(m: {
  messageId?: string | null;
  from?: string;
  date?: Date | null;
  subject?: string;
  bodyText: string;
}): { messageIdHash: string | null; contentHash: string } {
  const messageId = m.messageId?.trim().toLowerCase() ?? '';
  const date = m.date && !Number.isNaN(m.date.getTime()) ? floorToMinute(m.date).toISOString() : '';
  const content = [
    (m.from ?? '').toLowerCase().trim(),
    date,
    (m.subject ?? '').trim(),
    m.bodyText.replace(/\s+/g, ' ').trim(),
  ].join('|');
  return { messageIdHash: messageId ? hmacHex(messageId) : null, contentHash: hmacHex(content) };
}

function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

export function senderHash(address: string): string {
  return hmacHex(address.trim().toLowerCase());
}

export function senderDomainHash(domain: string): string {
  return hmacHex(domain.trim().toLowerCase());
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

/** First-import gate (FR-061, SC-014). Defined here so sources.ts can re-export it without an import cycle. */
export async function assertFiltersConfirmed(userId: string, db: DbOrTx = getDb()): Promise<void> {
  await confirmedPolicyVersion(userId, db);
}

async function confirmedPolicyVersion(userId: string, db: DbOrTx): Promise<number> {
  const [prefs] = await db
    .select({ confirmedAt: filterPreferences.confirmedAt, version: filterPreferences.version })
    .from(filterPreferences)
    .where(eq(filterPreferences.userId, userId))
    .limit(1);
  if (!prefs || prefs.confirmedAt === null) throw new AppError('filter_confirmation_required');
  return prefs.version;
}

/**
 * Creates a `queued` job pinned to the current `filter_preferences.version`. Does not enqueue: callers run
 * `enqueuePage` after their transaction commits.
 */
export async function createJob(
  input: { userId: string; sourceId: string; kind: ImportJobKind },
  db: DbOrTx = getDb(),
): Promise<{ id: string }> {
  const filterPolicyVersion = await confirmedPolicyVersion(input.userId, db);
  const [source] = await db
    .select({ id: connectedSource.id })
    .from(connectedSource)
    .where(and(eq(connectedSource.id, input.sourceId), eq(connectedSource.userId, input.userId)))
    .limit(1);
  if (!source) throw new AppError('not_found');
  // Upload jobs are one per upload and may run side by side (D-U1).
  if (input.kind !== 'upload') {
    const [active] = await db
      .select({ id: importJob.id })
      .from(importJob)
      .where(and(eq(importJob.sourceId, input.sourceId), inArray(importJob.status, NON_TERMINAL_STATUSES)))
      .limit(1);
    if (active) throw new AppError('conflict', 'An import is already in progress for this source');
  }
  const [row] = await db
    .insert(importJob)
    .values({ userId: input.userId, sourceId: input.sourceId, kind: input.kind, status: 'queued', filterPolicyVersion })
    .returning({ id: importJob.id });
  if (!row) throw new Error('import_job_insert_failed');
  return { id: row.id };
}

export async function setRunning(jobId: string): Promise<void> {
  const now = new Date();
  await getDb()
    .update(importJob)
    .set({ status: 'running', startedAt: sql`coalesce(${importJob.startedAt}, ${now})`, lastActivityAt: now })
    .where(and(eq(importJob.id, jobId), eq(importJob.status, 'queued')));
}

export async function setTotalEstimate(jobId: string, n: number): Promise<void> {
  await getDb().update(importJob).set({ totalEstimate: Math.max(0, Math.trunc(n)) }).where(eq(importJob.id, jobId));
}

/**
 * Completes a queued/running job (a paused or cancelled job is left alone). Sends `import_completed` only for the
 * first completed `initial` import of the source (D-C19).
 */
export async function complete(jobId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const now = new Date();
    const [job] = await tx
      .update(importJob)
      .set({ status: 'completed', finishedAt: now, lastActivityAt: now, pauseReason: null })
      .where(and(eq(importJob.id, jobId), inArray(importJob.status, ['queued', 'running'])))
      .returning();
    if (!job) return;

    const [{ n: itemCount }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(contentItemOccurrence)
      .innerJoin(contentItem, eq(contentItem.id, contentItemOccurrence.contentItemId))
      .where(and(eq(contentItemOccurrence.sourceId, job.sourceId), ne(contentItem.status, 'pending_deletion')))) as [
      { n: number },
    ];
    await tx
      .update(connectedSource)
      .set({ lastSyncAt: now, itemCount })
      .where(eq(connectedSource.id, job.sourceId));

    if (job.kind === 'initial' || job.kind === 'resync') {
      await tx
        .update(syncCursor)
        .set({ initialComplete: true, updatedAt: now })
        .where(eq(syncCursor.sourceId, job.sourceId));
    }

    if (job.kind === 'initial') {
      const [earlier] = await tx
        .select({ id: importJob.id })
        .from(importJob)
        .where(and(eq(importJob.sourceId, job.sourceId), eq(importJob.status, 'completed'), ne(importJob.id, job.id)))
        .limit(1);
      if (!earlier) {
        await notify(
          job.userId,
          'import_completed',
          { sourceId: job.sourceId, importJobId: job.id, itemsImported: job.itemsImported },
          tx,
        );
      }
    }
    // Profile hooks run in the import processor (T121).
  });
}

export async function failJob(jobId: string, errorCode: string): Promise<void> {
  const now = new Date();
  await getDb()
    .update(importJob)
    .set({ status: 'failed', errorCode, finishedAt: now, lastActivityAt: now })
    .where(and(eq(importJob.id, jobId), inArray(importJob.status, NON_TERMINAL_STATUSES)));
}

let pageSeq = 0;

/**
 * Per-page BullMQ job ids (D-C6): a fixed `import-{sourceId}` id would be ignored while the previous page job still
 * exists. The counter keeps two enqueues in the same millisecond distinct.
 */
export async function enqueuePage(
  p: { userId: string; sourceId: string; importJobId: string },
  opts: { delay?: number } = {},
): Promise<void> {
  pageSeq = (pageSeq + 1) % 1000;
  await enqueue('import.page', p, {
    jobId: jobIds.importPage(p.sourceId, `${Date.now()}-${pageSeq}`),
    ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
  });
}

const RELEASE_LOCK_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** One page in flight per source (D-C6). Returns a release function, or null when another page holds the lock. */
export async function acquireSourceLock(
  sourceId: string,
  ttlMs: number = SOURCE_LOCK_TTL_MS,
): Promise<null | (() => Promise<void>)> {
  const redis = getRedisConnection();
  const key = `vs:lock:${jobIds.import(sourceId)}`;
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  return async () => {
    await redis.eval(RELEASE_LOCK_LUA, 1, key, token);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Occurrences and dedup

export async function occurrenceExists(sourceId: string, providerRef: string, db: DbOrTx = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ id: contentItemOccurrence.id })
    .from(contentItemOccurrence)
    .where(and(eq(contentItemOccurrence.sourceId, sourceId), eq(contentItemOccurrence.providerRef, providerRef)))
    .limit(1);
  return row !== undefined;
}

export interface OccurrenceInput {
  contentItemId: string;
  sourceId: string;
  providerRef: string;
  folders: string[];
  isSent: boolean;
  importJobId: string;
}

/** Inserts the occurrence (idempotent) and bumps the source `item_count` when a row was added. */
export async function insertOccurrence(tx: Tx, input: OccurrenceInput): Promise<boolean> {
  const inserted = await tx
    .insert(contentItemOccurrence)
    .values({
      contentItemId: input.contentItemId,
      sourceId: input.sourceId,
      providerRef: input.providerRef,
      folders: input.folders,
      isSent: input.isSent,
      firstSeenImportJobId: input.importJobId,
    })
    .onConflictDoNothing({ target: [contentItemOccurrence.sourceId, contentItemOccurrence.providerRef] })
    .returning({ id: contentItemOccurrence.id });
  if (inserted.length === 0) return false;
  await tx
    .update(connectedSource)
    .set({ itemCount: sql`${connectedSource.itemCount} + 1` })
    .where(eq(connectedSource.id, input.sourceId));
  return true;
}

/**
 * Cross-source dedup (FR-014): an existing item with the same Message-ID hash (or, without a Message-ID, the same
 * content hash) only gains an occurrence, promoted to `authored` when this occurrence is sent.
 */
export async function upsertOccurrence(
  tx: Tx,
  input: {
    userId: string;
    sourceId: string;
    providerRef: string;
    folders: string[];
    isSent: boolean;
    importJobId: string;
    messageIdHash: string | null;
    contentHash: string;
  },
): Promise<{ status: 'duplicate'; contentItemId: string; promoted: boolean } | { status: 'new' }> {
  const match =
    input.messageIdHash !== null
      ? and(eq(contentItem.userId, input.userId), eq(contentItem.messageIdHash, input.messageIdHash))
      : and(
          eq(contentItem.userId, input.userId),
          eq(contentItem.contentHash, input.contentHash),
          eq(contentItem.kind, 'email'),
        );
  const [existing] = await tx
    .select({ id: contentItem.id, authorship: contentItem.authorship })
    .from(contentItem)
    .where(and(match, isNull(contentItem.parentItemId)))
    .limit(1);
  if (!existing) return { status: 'new' };

  await insertOccurrence(tx, {
    contentItemId: existing.id,
    sourceId: input.sourceId,
    providerRef: input.providerRef,
    folders: input.folders,
    isSent: input.isSent,
    importJobId: input.importJobId,
  });
  let promoted = false;
  if (input.isSent && existing.authorship !== 'authored') {
    await tx
      .update(contentItem)
      .set({ authorship: 'authored' })
      .where(eq(contentItem.id, existing.id));
    promoted = true;
  }
  return { status: 'duplicate', contentItemId: existing.id, promoted };
}

// ---------------------------------------------------------------------------------------------------------------
// Counts

const COUNTER_COLUMNS = {
  itemsDiscovered: importJob.itemsDiscovered,
  itemsProcessed: importJob.itemsProcessed,
  itemsImported: importJob.itemsImported,
  itemsDuplicate: importJob.itemsDuplicate,
  itemsExcluded: importJob.itemsExcluded,
  itemsRedacted: importJob.itemsRedacted,
  itemsSkipped: importJob.itemsSkipped,
  itemsFailed: importJob.itemsFailed,
} as const satisfies Record<ImportCounter, unknown>;

/**
 * Atomic increments of the job counters plus `exclusion_record`/`skip_record` upserts; always touches
 * `last_activity_at`. Skips are not added to `itemsSkipped` implicitly: pass both.
 */
export async function recordCounts(jobId: string, userId: string, delta: CountsDelta, db?: DbOrTx): Promise<void> {
  const run = async (d: DbOrTx) => {
    const set: Record<string, unknown> = { lastActivityAt: new Date() };
    for (const [key, n] of Object.entries(delta.counters ?? {}) as [ImportCounter, number | undefined][]) {
      if (!n) continue;
      const col = COUNTER_COLUMNS[key];
      set[key] = sql`${col} + ${Math.trunc(n)}`;
    }
    await d.update(importJob).set(set).where(eq(importJob.id, jobId));

    const exclusions = Object.entries(delta.exclusions ?? {}).filter(
      (e): e is [string, { excludedItems: number; redactedValues: number }] =>
        e[1] !== undefined && (e[1].excludedItems > 0 || e[1].redactedValues > 0),
    );
    if (exclusions.length > 0) {
      await d
        .insert(exclusionRecord)
        .values(
          exclusions.map(([category, c]) => ({
            importJobId: jobId,
            userId,
            category,
            excludedItems: Math.trunc(c.excludedItems),
            redactedValues: Math.trunc(c.redactedValues),
          })),
        )
        .onConflictDoUpdate({
          target: [exclusionRecord.importJobId, exclusionRecord.category],
          set: {
            excludedItems: sql`${exclusionRecord.excludedItems} + excluded.excluded_items`,
            redactedValues: sql`${exclusionRecord.redactedValues} + excluded.redacted_values`,
          },
        });
    }

    const skips = Object.entries(delta.skips ?? {}).filter((e): e is [SkipReason, number] => !!e[1] && e[1] > 0);
    if (skips.length > 0) {
      await d
        .insert(skipRecord)
        .values(skips.map(([reason, count]) => ({ importJobId: jobId, reason, count: Math.trunc(count) })))
        .onConflictDoUpdate({
          target: [skipRecord.importJobId, skipRecord.reason],
          set: { count: sql`${skipRecord.count} + excluded.count` },
        });
    }
  };
  if (db) await run(db);
  else await withTransaction(run);
}

/** Upserts the per-ref failure; a repeat increments `attempts`. Holds no content. */
export async function recordItemFailure(
  input: { importJobId: string; sourceId: string; providerRef: string; reason: ItemFailureReason },
  db: DbOrTx = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .insert(importItemFailure)
    .values({ ...input, attempts: 1, lastAttemptAt: now })
    .onConflictDoUpdate({
      target: [importItemFailure.sourceId, importItemFailure.providerRef],
      set: {
        importJobId: input.importJobId,
        reason: input.reason,
        attempts: sql`${importItemFailure.attempts} + 1`,
        lastAttemptAt: now,
      },
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Progress

export function toProgress(row: ImportJobRow): ImportProgress {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    pauseReason: row.pauseReason,
    itemsDiscovered: row.itemsDiscovered,
    itemsProcessed: row.itemsProcessed,
    itemsImported: row.itemsImported,
    itemsDuplicate: row.itemsDuplicate,
    itemsExcluded: row.itemsExcluded,
    itemsSkipped: row.itemsSkipped,
    itemsFailed: row.itemsFailed,
    totalEstimate: row.totalEstimate,
    remainingEstimate: row.totalEstimate == null ? null : Math.max(row.totalEstimate - row.itemsProcessed, 0),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
  };
}

export async function progress(jobId: string): Promise<ImportProgress | null> {
  if (!UUID_RE.test(jobId)) return null;
  const [row] = await getDb().select().from(importJob).where(eq(importJob.id, jobId)).limit(1);
  return row ? toProgress(row) : null;
}

async function ownedJob(ctx: ServiceContext, jobId: string): Promise<ImportJobRow> {
  if (!UUID_RE.test(jobId)) throw new AppError('not_found');
  const [row] = await getDb()
    .select()
    .from(importJob)
    .where(and(eq(importJob.id, jobId), eq(importJob.userId, ctx.userId)))
    .limit(1);
  if (!row) throw new AppError('not_found');
  return row;
}

export async function getForUser(ctx: ServiceContext, jobId: string): Promise<ImportProgress> {
  return toProgress(await ownedJob(ctx, jobId));
}

/** Newest first: not yet started jobs, then by start time. */
export async function listForSource(
  ctx: ServiceContext,
  sourceId: string,
  limit: number = RECENT_IMPORTS_LIMIT,
): Promise<ImportProgress[]> {
  if (!UUID_RE.test(sourceId)) throw new AppError('not_found');
  const db = getDb();
  const [source] = await db
    .select({ id: connectedSource.id })
    .from(connectedSource)
    .where(and(eq(connectedSource.id, sourceId), eq(connectedSource.userId, ctx.userId)))
    .limit(1);
  if (!source) throw new AppError('not_found');
  const rows = await db
    .select()
    .from(importJob)
    .where(eq(importJob.sourceId, sourceId))
    .orderBy(sql`${importJob.startedAt} desc nulls first`, desc(importJob.finishedAt), asc(importJob.id))
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 100));
  return rows.map(toProgress);
}

const SUMMARY_ORDER: string[] = [...CATEGORY_DEFS.map((d) => d.key), 'user_rule', 'inspection_failed'];

/** Counts and category labels only, never values (FR-020). */
export async function exclusionSummary(ctx: ServiceContext, jobId: string): Promise<ExclusionSummary> {
  const job = await ownedJob(ctx, jobId);
  const db = getDb();
  const [records, skips] = await Promise.all([
    db.select().from(exclusionRecord).where(eq(exclusionRecord.importJobId, job.id)),
    db.select().from(skipRecord).where(eq(skipRecord.importJobId, job.id)),
  ]);
  const rank = (k: string) => {
    const i = SUMMARY_ORDER.indexOf(k);
    return i === -1 ? SUMMARY_ORDER.length : i;
  };
  return {
    importJobId: job.id,
    categories: records
      .sort((a, b) => rank(a.category) - rank(b.category))
      .map((r) => ({
        key: r.category,
        label: labelFor(r.category as CountCategory),
        excludedItems: r.excludedItems,
        redactedValues: r.redactedValues,
      })),
    skipped: skips
      .sort((a, b) => SKIP_REASONS.indexOf(a.reason) - SKIP_REASONS.indexOf(b.reason))
      .map((s) => ({ reason: s.reason, count: s.count })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cursors

const initialCheckpointSchema: z.ZodType<InitialCheckpoint> = z.union([
  z.object({ pageToken: z.string() }),
  z.object({ nextLink: z.string() }),
  z.object({ uidNext: z.number().int() }),
]);

const folderCursorSchema: z.ZodType<FolderCursor> = z.union([
  z.object({ historyId: z.string() }),
  z.object({ deltaLink: z.string() }),
  z.object({ uidValidity: z.string(), lastUid: z.number().int() }),
]);

/** Folder states of a source ordered by folder key; malformed jsonb reads as null (start over). */
export async function loadCursors(sourceId: string, db: DbOrTx = getDb()): Promise<FolderState[]> {
  const rows = await db
    .select()
    .from(syncCursor)
    .where(eq(syncCursor.sourceId, sourceId))
    .orderBy(asc(syncCursor.folderKey));
  return rows.map((r) => {
    const checkpoint = initialCheckpointSchema.safeParse(r.initialCheckpoint);
    const cursor = folderCursorSchema.safeParse(r.cursor);
    return {
      folderKey: r.folderKey,
      initialCheckpoint: r.initialCheckpoint !== null && checkpoint.success ? checkpoint.data : null,
      cursor: r.cursor !== null && cursor.success ? cursor.data : null,
      initialComplete: r.initialComplete,
    };
  });
}

/** Upserts one folder's `sync_cursor`; fields left undefined are unchanged. */
export async function checkpoint(
  sourceId: string,
  folderKey: string,
  data: { initialCheckpoint?: InitialCheckpoint | null; cursor?: FolderCursor | null; initialComplete?: boolean },
  db: DbOrTx = getDb(),
): Promise<void> {
  const now = new Date();
  const set: Partial<typeof syncCursor.$inferInsert> = { updatedAt: now };
  if (data.initialCheckpoint !== undefined) set.initialCheckpoint = data.initialCheckpoint as Record<string, unknown> | null;
  if (data.cursor !== undefined) set.cursor = data.cursor as Record<string, unknown> | null;
  if (data.initialComplete !== undefined) set.initialComplete = data.initialComplete;
  await db
    .insert(syncCursor)
    .values({
      sourceId,
      folderKey,
      initialCheckpoint: (data.initialCheckpoint ?? null) as Record<string, unknown> | null,
      cursor: (data.cursor ?? null) as Record<string, unknown> | null,
      initialComplete: data.initialComplete ?? false,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: [syncCursor.sourceId, syncCursor.folderKey], set });
}

import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import {
  connectedSource,
  contentItemOccurrence,
  getDb,
  importJob,
  user,
  withTransaction,
} from '@voicespark/db';
import { jobLogger } from '@voicespark/core/logger';
import type { JobPayload } from '@voicespark/core/queues';
import * as imports from '@voicespark/core/services/imports';
import * as profiles from '@voicespark/core/services/profiles';
import { loadOwnAddresses, loadPolicy } from '@voicespark/core/services/inspection';
import * as sources from '@voicespark/core/services/sources';
import {
  HistoryExpiredError,
  MailAuthError,
  mapLimit,
  RateLimitedError,
  UidValidityChangedError,
  type FolderState,
  type ImportMode,
  type MailFetcher,
  type MailPageResult,
} from '@voicespark/integrations/mail';
import { namespaceFor } from '@voicespark/integrations/supermemory';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';
import { mergeTally, newTally, processMessage, type PageContext, type PageSignal, type Tally } from '../import/process-item';

export const PAGE_SIZE = 100;
/** Zero-ref `listPage` calls one run may make while walking folders before handing over to the next page job. */
const MAX_LIST_CALLS = 25;
/** Delay before a page that found the source lock held tries again (the holder normally releases within seconds). */
export const LOCKED_RETRY_DELAY_MS = 1_000;

export type ImportPageOutcome = 'aborted' | 'locked' | 'page_done' | 'completed' | 'delayed' | 'resync_scheduled';

type ImportJob = Job<JobPayload<'import.page'>, unknown, 'import.page'>;
type JobRow = typeof importJob.$inferSelect;
type SourceRow = typeof connectedSource.$inferSelect;

interface PageResult {
  outcome: ImportPageOutcome;
  processed: number;
}

/** Errors a fetcher may hand back per message that concern the whole page (Gmail/IMAP return them as values). */
function isPageLevelError(e: unknown): e is Error {
  return (
    e instanceof MailAuthError ||
    e instanceof RateLimitedError ||
    e instanceof HistoryExpiredError ||
    e instanceof UidValidityChangedError
  );
}

/** Job, source and user still allow this page to run (jobs.md behavior 1). */
async function loadRunnable(p: JobPayload<'import.page'>): Promise<{ job: JobRow; source: SourceRow } | null> {
  const db = getDb();
  const [job] = await db.select().from(importJob).where(eq(importJob.id, p.importJobId)).limit(1);
  if (!job || job.sourceId !== p.sourceId || job.userId !== p.userId || job.kind === 'upload') return null;
  if (job.status !== 'queued' && job.status !== 'running') return null;
  const [source] = await db.select().from(connectedSource).where(eq(connectedSource.id, p.sourceId)).limit(1);
  if (!source || source.userId !== p.userId || source.status !== 'connected') return null;
  const [owner] = await db.select({ status: user.status }).from(user).where(eq(user.id, p.userId)).limit(1);
  if (owner?.status !== 'active') return null;
  return { job, source };
}

/** Which mode a folder needs for this job, or null when it has nothing to do. */
function modeFor(job: JobRow, s: FolderState): ImportMode | null {
  if (job.kind === 'incremental') {
    if (!s.initialComplete) return 'initial';
    return s.cursor ? 'incremental' : null;
  }
  return s.initialComplete ? null : job.kind === 'resync' ? 'resync' : 'initial';
}

const persistState = (sourceId: string, s: FolderState, db?: Parameters<typeof imports.checkpoint>[3]) =>
  imports.checkpoint(
    sourceId,
    s.folderKey,
    { initialCheckpoint: s.initialCheckpoint, cursor: s.cursor, initialComplete: s.initialComplete },
    db,
  );

async function existingRefs(sourceId: string, refs: string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = await getDb()
    .select({ ref: contentItemOccurrence.providerRef })
    .from(contentItemOccurrence)
    .where(and(eq(contentItemOccurrence.sourceId, sourceId), inArray(contentItemOccurrence.providerRef, refs)));
  return new Set(rows.map((r) => r.ref));
}

function countsOf(t: Tally, withProgress: { discovered: number; processed: number } | null): imports.CountsDelta {
  return {
    counters: {
      ...t.counters,
      itemsSkipped: Object.values(t.skips).reduce((n, v) => n + (v ?? 0), 0),
      ...(withProgress ? { itemsDiscovered: withProgress.discovered, itemsProcessed: withProgress.processed } : {}),
    },
    exclusions: t.exclusions,
    skips: t.skips,
  };
}

/**
 * `import.page` (T074, jobs.md behavior 1). One page per run under the per-source Redis lock (D-C6). The checkpoint
 * only advances for fully processed pages (D-C9): an aborted or failed page records what it wrote, but not its
 * progress, and the next run re-lists from the last page boundary where existing occurrences are skipped.
 */
export function createImportHandler(overrides: Partial<WorkerDeps> = {}): Handler<'import.page'> {
  let deps: WorkerDeps | undefined;
  return async (job, token) => {
    deps ??= defaultDeps(overrides);
    return runPage(job, token, deps);
  };
}

/** T121 (FR-035, FR-069): outdated flags and first-time generation. Best effort: the import itself is complete. */
async function afterImportComplete(userId: string, log: ReturnType<typeof jobLogger>): Promise<void> {
  try {
    await profiles.recomputeOutdated(userId);
    await profiles.autoGenerateIfFirstEligible(userId);
  } catch {
    log.warn({ errorCode: 'profile_hook_failed' });
  }
}

async function runPage(job: ImportJob, token: string | undefined, deps: WorkerDeps): Promise<PageResult> {
  const { userId, sourceId, importJobId } = job.data;
  const log = jobLogger(job.id ?? importJobId, { importJobId, sourceId });
  const release = await imports.acquireSourceLock(sourceId);
  if (!release) {
    // Another page of this source is in flight. Try again shortly rather than drop the page (a dropped page stalls
    // the import until maintenance.stale-imports), unless the job can no longer run (paused, aborted, disconnected).
    if (await loadRunnable(job.data)) {
      await imports.enqueuePage({ userId, sourceId, importJobId }, { delay: LOCKED_RETRY_DELAY_MS });
    }
    return { outcome: 'locked', processed: 0 };
  }

  /** Import job whose next page to enqueue once the lock is released (so the next page can take the lock). */
  let nextPageOf: string | undefined;
  let fetcher: MailFetcher | undefined;
  let currentFolder: string | undefined;
  let knownFolders: string[] = [];
  try {
    const loaded = await loadRunnable(job.data);
    if (!loaded) return { outcome: 'aborted', processed: 0 };
    const { job: row, source } = loaded;
    await imports.setRunning(importJobId);
    fetcher = await deps.openFetcher(sourceId);

    let states = await imports.loadCursors(sourceId);
    if (states.length === 0 || row.status === 'queued') {
      const known = new Set(states.map((s) => s.folderKey));
      const missing = (await fetcher.listFolders()).filter((f) => !known.has(f.folderKey));
      for (const f of missing) await imports.checkpoint(sourceId, f.folderKey, {});
      if (missing.length > 0) states = await imports.loadCursors(sourceId);
    }
    knownFolders = states.map((s) => s.folderKey);

    const dateRange = { from: source.dateRangeFrom, to: source.dateRangeTo };
    let page: { result: MailPageResult } | null = null;
    let budgetLeft = true;
    let calls = 0;
    walk: for (const initial of states) {
      let state = initial;
      for (;;) {
        const mode = modeFor(row, state);
        if (!mode) break;
        if (calls++ >= MAX_LIST_CALLS) {
          budgetLeft = false;
          break walk;
        }
        currentFolder = state.folderKey;
        const result = await fetcher.listPage(state, { mode, dateRange, limit: PAGE_SIZE });
        if (result.totalEstimate !== undefined && state.initialCheckpoint === null && mode !== 'incremental') {
          await imports.setTotalEstimate(importJobId, row.itemsDiscovered + result.totalEstimate);
        }
        if (result.refs.length > 0) {
          page = { result };
          break walk;
        }
        await persistState(sourceId, result.state);
        if (mode === 'incremental' || result.folderDone || result.state.initialComplete) break;
        state = result.state;
      }
    }

    if (!page) {
      if (!budgetLeft) {
        nextPageOf = importJobId;
        return { outcome: 'page_done', processed: 0 };
      }
      await imports.complete(importJobId);
      log.info({ status: 'completed' });
      await afterImportComplete(userId, log);
      return { outcome: 'completed', processed: 0 };
    }

    const { result } = page;
    const refs = result.refs;
    const existing = await existingRefs(
      sourceId,
      refs.map((r) => r.providerRef),
    );
    const pending = refs.filter((r) => !existing.has(r.providerRef));
    const fetched = pending.length > 0 ? await fetcher.fetchMessages(pending) : new Map();
    for (const v of fetched.values()) if (isPageLevelError(v)) throw v;

    const { policy } = await loadPolicy(userId);
    const ctx: PageContext = {
      userId,
      sourceId,
      importJobId,
      filterPolicyVersion: row.filterPolicyVersion,
      ns: namespaceFor(userId),
      dateRange,
      policy,
      ownAddresses: await loadOwnAddresses(userId),
      store: deps.store,
      classifier: deps.classifier,
    };
    const signal: PageSignal = { aborted: false };
    const tally = newTally();
    let processed = existing.size;
    let failure: { err: unknown } | undefined;

    await mapLimit(pending, fetcher.provider === 'microsoft' ? 4 : 10, async (ref) => {
      if (signal.aborted || failure) return;
      try {
        const f = fetched.get(ref.providerRef);
        if (!f || f instanceof Error) {
          await imports.recordItemFailure({ importJobId, sourceId, providerRef: ref.providerRef, reason: 'fetch_failed' });
          tally.counters.itemsFailed += 1;
          processed += 1;
          return;
        }
        const r = await processMessage(ctx, ref, f, signal);
        if (r.outcome === 'aborted') return;
        mergeTally(tally, r.tally);
        processed += 1;
      } catch (err) {
        failure ??= { err };
      }
    });

    if (failure || signal.aborted) {
      // Writes that happened are counted; page progress is not (the page is re-listed).
      await imports.recordCounts(importJobId, userId, countsOf(tally, null));
      if (failure) throw failure.err;
      log.info({ status: 'aborted', counts: tally.counters });
      return { outcome: 'aborted', processed: 0 };
    }

    await withTransaction(async (tx) => {
      await imports.recordCounts(
        importJobId,
        userId,
        countsOf(tally, { discovered: refs.length, processed }),
        tx,
      );
      await persistState(sourceId, result.state, tx);
    });
    nextPageOf = importJobId;
    log.info({ status: 'page_done', count: processed, counts: tally.counters });
    return { outcome: 'page_done', processed };
  } catch (err) {
    if (err instanceof MailAuthError) {
      await sources.markNeedsReconnection(sourceId, 'mail_auth');
      throw new UnrecoverableError('mail_auth');
    }
    if (err instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + err.retryAfterMs, token);
      throw new DelayedError();
    }
    if (err instanceof HistoryExpiredError || err instanceof UidValidityChangedError) {
      await imports.failJob(importJobId, 'cursor_expired');
      const affected =
        err instanceof UidValidityChangedError ? [err.folderKey] : currentFolder ? [currentFolder] : knownFolders;
      for (const folderKey of affected) {
        await imports.checkpoint(sourceId, folderKey, { initialCheckpoint: null, cursor: null, initialComplete: false });
      }
      const resync = await imports.createJob({ userId, sourceId, kind: 'resync' });
      nextPageOf = resync.id;
      log.warn({ status: 'resync_scheduled', errorCode: 'cursor_expired' });
      return { outcome: 'resync_scheduled', processed: 0 };
    }
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (finalAttempt) await imports.failJob(importJobId, 'import_failed');
    throw err;
  } finally {
    await fetcher?.close().catch(() => undefined);
    await release();
    if (nextPageOf) await imports.enqueuePage({ userId, sourceId, importJobId: nextPageOf });
  }
}

export const handlers: HandlerMap = {
  'import.page': createImportHandler(),
};

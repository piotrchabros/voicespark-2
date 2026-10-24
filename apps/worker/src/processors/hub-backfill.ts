import { DelayedError, type Job } from 'bullmq';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { connectedSource, contentItem, contentItemOccurrence, getDb, hubMailboxSetting, user } from '@voicespark/db';
import { toErrorCode } from '@voicespark/core/error-code';
import { jobLogger } from '@voicespark/core/logger';
import type { JobPayload } from '@voicespark/core/queues';
import * as hubIngest from '@voicespark/core/services/hub/ingest';
import * as imports from '@voicespark/core/services/imports';
import * as sources from '@voicespark/core/services/sources';
import { MailAuthError, RateLimitedError, type MailFetcher, type MailRef } from '@voicespark/integrations/mail';
import { parseMessage } from '@voicespark/integrations/mime';
import { defaultDeps, type WorkerDeps } from '../deps';
import { webLinkFor } from '../hub-links';
import type { Handler, HandlerMap } from '../handlers';

// `hub.backfill` (T116, contracts/jobs.md (12); data-model.md `hub_mailbox_setting`; FR-013). Feeds the hub with mail
// VoiceSpark already imported from one source: one page of active parent email occurrences per run, newest first,
// re-fetched read-only through the existing fetcher and handed to `recordMessage`. The job re-delays itself (same id
// `hubbackfill-{sourceId}`) between pages so the per-source lock is free for `import.page` in between. Thread jobs it
// causes are held by the daily cap in `hub.thread` (jobs.md (11), rule 7). Logs carry ids, counts and codes only.

export const BACKFILL_PAGE_SIZE = 100;
/** Source `paused` or `needs_reconnection`: try again later without changing `backfill_state`. */
export const BACKFILL_RETRY_DELAY_MS = 15 * 60_000;
/** Lock held by an `import.page` of the same source (it releases within seconds). */
export const BACKFILL_LOCKED_DELAY_MS = 5_000;
/** Delay before the next page of a running backfill. */
export const BACKFILL_NEXT_PAGE_DELAY_MS = 0;

export type HubBackfillOutcome = 'stopped' | 'rescheduled' | 'locked' | 'page_done' | 'done';

export interface HubBackfillResult {
  outcome: HubBackfillOutcome;
  /** Messages handed to `recordMessage` in this run. */
  recorded: number;
  /** Re-delay of the same job, when the backfill continues later. */
  delayMs?: number;
}

/** Position after the last processed occurrence (an item date and an id; no content). */
export interface BackfillCursor {
  itemDate: string;
  id: string;
}

type HubBackfillJob = Job<JobPayload<'hub.backfill'>, unknown, 'hub.backfill'>;
type SourceRow = typeof connectedSource.$inferSelect;

interface PageRow {
  id: string;
  providerRef: string;
  folders: string[] | null;
  isSent: boolean | null;
  itemDate: Date;
}

export function createHubBackfillHandler(overrides: Partial<WorkerDeps> = {}): Handler<'hub.backfill'> {
  let deps: WorkerDeps | undefined;
  return async (job, token) => {
    deps ??= defaultDeps(overrides);
    const result = await runBackfill(job, deps);
    if (result.delayMs !== undefined) {
      await job.moveToDelayed(Date.now() + result.delayMs, token);
      throw new DelayedError();
    }
    return result;
  };
}

/** Gmail lists every message under `_all`; Graph refs carry their folder id; IMAP refs embed the folder path. */
function refFor(type: SourceRow['type'], row: PageRow): MailRef {
  return { providerRef: row.providerRef, folderKey: type === 'gmail' ? '_all' : (row.folders?.[0] ?? '') };
}

function parseCursor(value: unknown): BackfillCursor | null {
  const c = value as Partial<BackfillCursor> | null;
  return c && typeof c.itemDate === 'string' && typeof c.id === 'string' ? { itemDate: c.itemDate, id: c.id } : null;
}

async function loadSetting(p: JobPayload<'hub.backfill'>) {
  const [row] = await getDb()
    .select()
    .from(hubMailboxSetting)
    .where(and(eq(hubMailboxSetting.sourceId, p.sourceId), eq(hubMailboxSetting.userId, p.userId)))
    .limit(1);
  return row ?? null;
}

async function loadSource(p: JobPayload<'hub.backfill'>): Promise<SourceRow | null> {
  const [row] = await getDb().select().from(connectedSource).where(eq(connectedSource.id, p.sourceId)).limit(1);
  return row && row.userId === p.userId ? row : null;
}

async function userActive(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.status === 'active';
}

/** Active parent email occurrences of the source after `cursor`, newest item first (ties by occurrence id). */
async function nextPage(sourceId: string, cursor: BackfillCursor | null): Promise<PageRow[]> {
  return getDb()
    .select({
      id: contentItemOccurrence.id,
      providerRef: contentItemOccurrence.providerRef,
      folders: contentItemOccurrence.folders,
      isSent: contentItemOccurrence.isSent,
      itemDate: contentItem.itemDate,
    })
    .from(contentItemOccurrence)
    .innerJoin(contentItem, eq(contentItem.id, contentItemOccurrence.contentItemId))
    .where(
      and(
        eq(contentItemOccurrence.sourceId, sourceId),
        eq(contentItem.kind, 'email'),
        eq(contentItem.status, 'active'),
        isNull(contentItem.parentItemId),
        cursor
          ? sql`(${contentItem.itemDate}, ${contentItemOccurrence.id}) < (${cursor.itemDate}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(contentItem.itemDate), desc(contentItemOccurrence.id))
    .limit(BACKFILL_PAGE_SIZE);
}

/** State and cursor move only while the hub is still on for the source (a disable mid-page wins). */
async function saveProgress(sourceId: string, state: 'running' | 'done', cursor: BackfillCursor | null): Promise<void> {
  await getDb()
    .update(hubMailboxSetting)
    .set({ backfillState: state, backfillCursor: cursor, updatedAt: new Date() })
    .where(and(eq(hubMailboxSetting.sourceId, sourceId), eq(hubMailboxSetting.enabled, true)));
}

async function runBackfill(job: HubBackfillJob, deps: WorkerDeps): Promise<HubBackfillResult> {
  const p = job.data;
  const log = jobLogger(job.id ?? p.sourceId, { userId: p.userId, sourceId: p.sourceId });

  const setting = await loadSetting(p);
  if (!setting?.enabled || setting.backfillState === 'done' || !(await userActive(p.userId))) {
    return { outcome: 'stopped', recorded: 0 };
  }
  const source = await loadSource(p);
  if (!source || source.status === 'disconnected') return { outcome: 'stopped', recorded: 0 };
  if (source.status !== 'connected') {
    log.info({ status: 'rescheduled' });
    return { outcome: 'rescheduled', recorded: 0, delayMs: BACKFILL_RETRY_DELAY_MS };
  }

  const release = await imports.acquireSourceLock(p.sourceId);
  if (!release) return { outcome: 'locked', recorded: 0, delayMs: BACKFILL_LOCKED_DELAY_MS };

  let fetcher: MailFetcher | undefined;
  try {
    const cursor = parseCursor(setting.backfillCursor);
    const rows = await nextPage(p.sourceId, cursor);
    if (rows.length === 0) {
      await saveProgress(p.sourceId, 'done', cursor);
      log.info({ status: 'done' });
      return { outcome: 'done', recorded: 0 };
    }
    if (setting.backfillState !== 'running') await saveProgress(p.sourceId, 'running', cursor);

    fetcher = await deps.openFetcher(p.sourceId);
    const fetched = await fetcher.fetchMessages(rows.map((r) => refFor(source.type, r)));

    let recorded = 0;
    let failed = 0;
    for (const row of rows) {
      const f = fetched.get(row.providerRef);
      if (f instanceof MailAuthError || f instanceof RateLimitedError) throw f;
      if (!f || f instanceof Error) {
        // Gone at the provider or unreadable: the hub only covers what can be fetched.
        failed += 1;
        continue;
      }
      try {
        // `is_sent` already folds in "From is an own address" (import.page).
        const authored = row.isSent ?? f.isSent;
        const parsed = await parseMessage(f.raw, { authored, folders: f.folders });
        await hubIngest.recordMessage({
          userId: p.userId,
          sourceId: p.sourceId,
          providerRef: row.providerRef,
          folders: f.folders,
          parsed,
          direction: authored ? 'outbound' : 'inbound',
          webLink: webLinkFor(source.type, row.providerRef),
        });
        recorded += 1;
      } catch (err) {
        failed += 1;
        log.warn({ errorCode: toErrorCode(err) });
      }
    }

    const last = rows[rows.length - 1]!;
    const next: BackfillCursor = { itemDate: last.itemDate.toISOString(), id: last.id };
    const finished = rows.length < BACKFILL_PAGE_SIZE;
    await saveProgress(p.sourceId, finished ? 'done' : 'running', next);
    log.info({ status: finished ? 'done' : 'page_done', counts: { recorded, failed } });
    return finished
      ? { outcome: 'done', recorded }
      : { outcome: 'page_done', recorded, delayMs: BACKFILL_NEXT_PAGE_DELAY_MS };
  } catch (err) {
    if (err instanceof MailAuthError) {
      await sources.markNeedsReconnection(p.sourceId, 'mail_auth');
      log.warn({ status: 'rescheduled', errorCode: 'mail_auth' });
      return { outcome: 'rescheduled', recorded: 0, delayMs: BACKFILL_RETRY_DELAY_MS };
    }
    if (err instanceof RateLimitedError) {
      return { outcome: 'rescheduled', recorded: 0, delayMs: err.retryAfterMs };
    }
    throw err;
  } finally {
    await fetcher?.close().catch(() => undefined);
    await release();
  }
}

export const handlers: HandlerMap = {
  'hub.backfill': createHubBackfillHandler(),
};

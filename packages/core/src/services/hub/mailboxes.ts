import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import {
  getDb,
  hubMailboxSetting,
  hubThread,
  hubThreadSource,
  withTransaction,
  type HubMailboxSetting,
} from '@voicespark/db';
import * as mail from '@voicespark/db/repos/user/hub-mail';
import { getSource, listSources, type ConnectedSourceRow } from '@voicespark/db/repos/user/sources';
import { AppError, type ServiceContext } from '../../errors';
import { logger } from '../../logger';
import { enqueue, jobIds } from '../../queues';
import { audit } from '../audit';
import { requestDeletion } from '../deletion';
import { getSetting } from '../settings';
import { hubNotFound } from './common';

// Per-mailbox hub switch (US3; contracts/http-api.md "Mailboxes and ignore rules"; FR-012, FR-022, FR-031). The hub
// is off for a source without a `hub_mailbox_setting` row. The purge behind `disable({hubData: 'delete'})` is the
// US8 mailbox work; here only the `hub_source` deletion request is created.

/** Version id of the consent text shown before the hub is enabled (a slug: it is stored and audited). */
export const HUB_CONSENT_TEXT_VERSION = 'hub-ai-2026-10';

const AUDIT_TARGET = 'source';
const DAY_MS = 24 * 60 * 60 * 1000;

const enableSchema = z.object({ acknowledgeAi: z.literal(true) });
const disableSchema = z.object({ hubData: z.enum(['keep', 'delete']) });

export interface FailedThreadView {
  id: string;
  subjectAvailable: false;
  errorCode: string | null;
  attempts: number;
  lastAttemptAt: string | null;
}

export interface MailboxView {
  sourceId: string;
  accountLabel: string;
  status: ConnectedSourceRow['status'];
  enabled: boolean;
  enabledAt: string | null;
  backfillState: 'none' | 'pending' | 'running' | 'done';
  pausedUntil: string | null;
  threadsProcessed: number;
  threadsSkipped: number;
  threadsFailed: number;
  lastRunAt: string | null;
  dataChoice: 'keep' | 'delete' | null;
  failedThreads: FailedThreadView[];
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
    throw new AppError('validation_failed', undefined, { fields });
  }
  return r.data;
}

async function ownedSource(ctx: ServiceContext, sourceId: string): Promise<ConnectedSourceRow> {
  if (!z.uuid().safeParse(sourceId).success) throw hubNotFound();
  const source = await getSource(ctx, sourceId);
  if (!source) throw hubNotFound();
  return source;
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS);
}

async function failedThreadsBySource(ctx: ServiceContext): Promise<Map<string, FailedThreadView[]>> {
  const rows = await getDb()
    .select({
      sourceId: hubThreadSource.sourceId,
      id: hubThread.id,
      errorCode: hubThread.lastErrorCode,
      attempts: hubThread.attempts,
      processedAt: hubThread.processedAt,
    })
    .from(hubThread)
    .innerJoin(hubThreadSource, eq(hubThreadSource.threadId, hubThread.id))
    .where(and(eq(hubThread.userId, ctx.userId), eq(hubThread.status, 'failed')))
    .orderBy(asc(hubThread.createdAt), asc(hubThread.id));
  const map = new Map<string, FailedThreadView[]>();
  for (const r of rows) {
    if (!r.sourceId) continue;
    const list = map.get(r.sourceId) ?? [];
    list.push({
      id: r.id,
      subjectAvailable: false,
      errorCode: r.errorCode,
      attempts: r.attempts,
      lastAttemptAt: r.processedAt?.toISOString() ?? null,
    });
    map.set(r.sourceId, list);
  }
  return map;
}

async function pausedUntilFor(ctx: ServiceContext, cap: number, now: Date): Promise<string | null> {
  const used = await mail.countLlmCallsSince(ctx, new Date(now.getTime() - DAY_MS), 'extract');
  return used >= cap ? nextUtcMidnight(now).toISOString() : null;
}

function view(
  source: ConnectedSourceRow,
  s: HubMailboxSetting | null,
  failed: FailedThreadView[],
  pausedUntil: string | null,
): MailboxView {
  const enabled = s?.enabled === true;
  return {
    sourceId: source.id,
    accountLabel: source.accountLabel,
    status: source.status,
    enabled,
    enabledAt: s?.enabledAt?.toISOString() ?? null,
    backfillState: (s?.backfillState ?? 'none') as MailboxView['backfillState'],
    pausedUntil: enabled ? pausedUntil : null,
    threadsProcessed: s?.threadsProcessed ?? 0,
    threadsSkipped: s?.threadsSkipped ?? 0,
    // Recomputed from the threads themselves: the stored counter can lag.
    threadsFailed: failed.length,
    lastRunAt: s?.lastRunAt?.toISOString() ?? null,
    dataChoice: (s?.dataChoice ?? null) as MailboxView['dataChoice'],
    failedThreads: failed,
  };
}

async function viewOne(ctx: ServiceContext, source: ConnectedSourceRow): Promise<MailboxView> {
  const setting = await mail.getMailboxSetting(ctx, source.id);
  const failed = (await failedThreadsBySource(ctx)).get(source.id) ?? [];
  const now = new Date();
  const paused = setting?.enabled ? await pausedUntilFor(ctx, await getSetting('hub.daily_thread_cap_per_user'), now) : null;
  return view(source, setting, failed, paused);
}

/** Every source of the user with its hub state; sources without a row are off. */
export async function list(ctx: ServiceContext): Promise<MailboxView[]> {
  const [sources, settings, failed, cap] = await Promise.all([
    listSources(ctx),
    mail.listMailboxSettings(ctx),
    failedThreadsBySource(ctx),
    getSetting('hub.daily_thread_cap_per_user'),
  ]);
  const bySource = new Map(settings.map((s) => [s.sourceId, s]));
  const paused = settings.some((s) => s.enabled) ? await pausedUntilFor(ctx, cap, new Date()) : null;
  return sources.map((src) => view(src, bySource.get(src.id) ?? null, failed.get(src.id) ?? [], paused));
}

/** Whether the hub is on for a source (worker and sync paths; no user context needed). */
export async function isEnabled(sourceId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ enabled: hubMailboxSetting.enabled })
    .from(hubMailboxSetting)
    .where(eq(hubMailboxSetting.sourceId, sourceId))
    .limit(1);
  return row?.enabled === true;
}

/**
 * Turns the hub on. Needs `{acknowledgeAi: true}` (422 otherwise), records the consent text version, sets
 * `backfill_state = pending` and enqueues `hub.backfill`. 409 `conflict` when already enabled; a foreign source is 404.
 */
export async function enable(ctx: ServiceContext, sourceId: string, input: unknown): Promise<MailboxView> {
  parse(enableSchema, input);
  const source = await ownedSource(ctx, sourceId);
  await withTransaction(async (tx) => {
    if (await mail.isMailboxEnabled(ctx, sourceId, tx)) throw new AppError('conflict');
    await mail.enableMailbox(ctx, sourceId, HUB_CONSENT_TEXT_VERSION, tx);
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'hub.mailbox_enabled',
        targetType: AUDIT_TARGET,
        targetId: sourceId,
        metadata: { sourceId, consentTextVersion: HUB_CONSENT_TEXT_VERSION },
      },
      tx,
    );
  });
  try {
    await enqueue('hub.backfill', { userId: ctx.userId, sourceId }, { jobId: jobIds.hubBackfill(sourceId) });
  } catch {
    // The row stays `pending`; logged by code only.
    logger.warn({ userId: ctx.userId, entityId: sourceId, errorCode: 'hub_backfill_enqueue_failed' }, 'hub.backfill not enqueued');
  }
  return viewOne(ctx, source);
}

/**
 * Turns the hub off and records the data choice. `delete` also creates a `hub_source` deletion request (the purge is
 * US8). 409 `hub_not_enabled` when the hub is not on for the source.
 */
export async function disable(
  ctx: ServiceContext,
  sourceId: string,
  input: unknown,
): Promise<{ mailbox: MailboxView; deletionRequestId: string | null }> {
  const { hubData } = parse(disableSchema, input);
  const source = await ownedSource(ctx, sourceId);
  await withTransaction(async (tx) => {
    if (!(await mail.isMailboxEnabled(ctx, sourceId, tx))) throw new AppError('hub_not_enabled');
    await mail.disableMailbox(ctx, sourceId, hubData, tx);
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'hub.mailbox_disabled',
        targetType: AUDIT_TARGET,
        targetId: sourceId,
        metadata: { sourceId, hubData },
      },
      tx,
    );
  });
  const deletionRequestId =
    hubData === 'delete'
      ? (await requestDeletion({ userId: ctx.userId, scope: 'hub_source', targetId: sourceId, requestedBy: 'user' })).id
      : null;
  return { mailbox: await viewOne(ctx, source), deletionRequestId };
}

/** Moves a `failed` thread of the source back to `pending` and enqueues `hub.thread`; 409 `conflict` otherwise. */
export async function retryThread(ctx: ServiceContext, sourceId: string, threadId: string): Promise<void> {
  await ownedSource(ctx, sourceId);
  if (!z.uuid().safeParse(threadId).success) throw hubNotFound();
  const thread = await mail.getThread(ctx, threadId);
  if (!thread) throw hubNotFound();
  const linked = (await mail.listThreadSources(ctx, threadId)).some((l) => l.sourceId === sourceId);
  if (!linked) throw hubNotFound();
  if (!(await mail.retryFailedThread(ctx, threadId))) throw new AppError('conflict');
  try {
    await enqueue(
      'hub.thread',
      { userId: ctx.userId, threadId, version: thread.version },
      { jobId: jobIds.hubThread(threadId, thread.version) },
    );
  } catch {
    // The row is `pending` and due; the thread sweep picks it up.
    logger.warn({ userId: ctx.userId, entityId: threadId, errorCode: 'hub_thread_enqueue_failed' }, 'hub.thread not enqueued');
  }
}

import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import {
  connectedSource,
  getDb,
  hubMailboxSetting,
  hubThread,
  user,
  withTransaction,
  type HubMessage,
} from '@voicespark/db';
import * as mail from '@voicespark/db/repos/user/hub-mail';
import * as records from '@voicespark/db/repos/user/hub-records';
import {
  claimThread,
  completeThread,
  countExtractedThreadsSince,
} from '@voicespark/db/repos/system/hub';
import { AppError } from '@voicespark/core/errors';
import { toErrorCode } from '@voicespark/core/error-code';
import { addressHash, isFreeMailDomain } from '@voicespark/core/hub/normalize';
import {
  HUB_EXTRACTION_PROMPT_VERSION,
  type HubPromptKnownRecord,
} from '@voicespark/core/hub/prompts';
import { jobLogger } from '@voicespark/core/logger';
import type { JobPayload } from '@voicespark/core/queues';
import { applyExtraction, type ApplyResult } from '@voicespark/core/services/hub/apply';
import { decryptContent, encryptContent } from '@voicespark/core/services/hub/common';
import {
  HubExtractionError,
  extract,
  inspectThreadForExtraction,
  selectParticipants,
  shouldTriage,
  toPromptParticipants,
  triage,
  type HubCallContext,
  type HubInspectMessage,
} from '@voicespark/core/services/hub/extraction';
import * as ignoreRules from '@voicespark/core/services/hub/ignore-rules';
import { domainHash } from '@voicespark/core/services/hub/records';
import { loadOwnAddresses, loadPolicy } from '@voicespark/core/services/inspection';
import { getSetting } from '@voicespark/core/services/settings';
import * as sources from '@voicespark/core/services/sources';
import { inspectSegments, type Policy } from '@voicespark/filters';
import {
  MailAuthError,
  type FetchedMessage,
  type MailFetcher,
  type MailRef,
} from '@voicespark/integrations/mail';
import {
  classifyAutomated,
  cleanHubBody,
  parseMessage,
  threadIsAutomated,
  type AutomatedReason,
  type ParsedMessage,
} from '@voicespark/integrations/mime';
import { defaultDeps, type WorkerDeps } from '../deps';
import type { Handler, HandlerMap } from '../handlers';
import { withLlmSlot } from '../llm-limiter';

// `hub.thread` (T122, contracts/jobs.md (11), contracts/hub-extraction.md; FR-013..FR-021, SC-007..SC-009). The row owns
// the run: claim under a 600 s lease, check the daily cap, re-fetch the messages read-only through a connected
// hub-enabled source, classify, select participants, clean, inspect in hub mode, optional triage, extract, then
// `applyExtraction` (which inspects the outputs and completes the thread under the apply lock). Skips before the apply
// complete the thread here. Retries are written to the row (attempts, backoff, `failed` after 8); the BullMQ job never
// retries. The job never reads or writes content outside these steps, and logs ids, counts, skip reasons and codes only.

/** `fetch_unavailable`, `source_auth`: retry in 15 min, attempts unchanged. */
export const HUB_REFETCH_DELAY_MS = 15 * 60_000;
export const HUB_THREAD_MAX_ATTEMPTS = 8;
const DAY_MS = 24 * 3600 * 1000;

export type HubThreadErrorCode =
  | 'llm_refused'
  | 'llm_bad_output'
  | 'llm_rate_limited'
  | 'llm_unavailable'
  | 'inspection_failed'
  | 'fetch_unavailable'
  | 'source_auth'
  | 'daily_cap_reached'
  | 'apply_failed';

/** Final at once: the thread becomes `failed` without further attempts. */
const FINAL_CODES: ReadonlySet<HubThreadErrorCode> = new Set(['llm_refused', 'llm_bad_output']);

type SkipReason = NonNullable<(typeof hubThread.$inferSelect)['skipReason']>;

export type HubThreadOutcome =
  /** User not active or thread gone. */
  | 'aborted'
  /** Not due, leased by another run, or already processed. */
  | 'not_claimed'
  | 'done'
  | 'skipped'
  /** Released without counting an attempt (cap, no source, mailbox auth). */
  | 'released'
  /** An attempt was counted; the thread is due again after the backoff. */
  | 'retry'
  | 'failed'
  | 'lease_lost';

export interface HubThreadResult {
  outcome: HubThreadOutcome;
  skipReason?: SkipReason | null;
  errorCode?: HubThreadErrorCode;
  counts?: Record<string, number>;
}

type HubThreadJob = Job<JobPayload<'hub.thread'>, unknown, 'hub.thread'>;
type SourceRow = Pick<typeof connectedSource.$inferSelect, 'id' | 'type' | 'status'> & {
  enabled: boolean;
};

/** A failed step with its row-level code. Never carries content. */
class ThreadError extends Error {
  constructor(readonly code: HubThreadErrorCode) {
    super(code);
  }
}

export function createHubThreadHandler(overrides: Partial<WorkerDeps> = {}): Handler<'hub.thread'> {
  let deps: WorkerDeps | undefined;
  return async (job) => {
    deps ??= defaultDeps(overrides);
    return runThread(job, deps);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Row state changes (lease-guarded: a run that lost its lease changes nothing)

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : (res as { rows: T[] }).rows);

/** Releases the lease without counting an attempt; due again at `at`. */
async function release(threadId: string, at: Date, code: HubThreadErrorCode): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE hub_thread
    SET next_attempt_at = ${at.toISOString()}::timestamptz, last_error_code = ${code}, locked_until = NULL
    WHERE id = ${threadId} AND locked_until IS NOT NULL AND locked_until >= now()
    RETURNING id
  `);
  return rowsOf(res).length > 0;
}

/**
 * Counts an attempt. Backoff `min(5 s * 2^(n-1), 15 min)` with +/-20% jitter (n = the new attempt count; the SET
 * expressions see the old `attempts`). At 8 attempts, or for a final code, the thread is `failed` with no next attempt.
 */
async function failAttempt(
  threadId: string,
  code: HubThreadErrorCode,
): Promise<'retry' | 'failed' | 'lease_lost'> {
  const final = FINAL_CODES.has(code);
  const res = await getDb().execute(sql`
    UPDATE hub_thread
    SET attempts = attempts + 1,
        last_error_code = ${code},
        status = CASE WHEN ${final} OR attempts + 1 >= ${HUB_THREAD_MAX_ATTEMPTS}
                      THEN 'failed'::hub_thread_status ELSE 'pending'::hub_thread_status END,
        next_attempt_at = CASE WHEN ${final} OR attempts + 1 >= ${HUB_THREAD_MAX_ATTEMPTS} THEN NULL
                               ELSE now() + make_interval(secs => least(5 * power(2, attempts), 900) * (0.8 + random() * 0.4)) END,
        locked_until = NULL
    WHERE id = ${threadId} AND locked_until IS NOT NULL AND locked_until >= now()
    RETURNING status
  `);
  const row = rowsOf<{ status: string }>(res)[0];
  return row === undefined ? 'lease_lost' : row.status === 'failed' ? 'failed' : 'retry';
}

/** A skip before the apply: completes the claimed version and bumps the mailbox counters in one transaction. */
async function skip(
  userId: string,
  threadId: string,
  claimed: number,
  reason: SkipReason,
): Promise<boolean> {
  return withTransaction(async (tx) => {
    if (!(await completeThread(threadId, claimed, 'skipped', reason, tx))) return false;
    await mail.bumpMailboxCounters({ userId }, threadId, 'skipped', tx);
    return true;
  });
}

/** Subject under the user's full policy; null when it was excluded. Written while the lease is held. */
async function storeSubject(
  threadId: string,
  subject: string,
  policy: Policy,
  deps: WorkerDeps,
): Promise<void> {
  let value: string | null = null;
  if (subject.trim() !== '') {
    let r: Awaited<ReturnType<typeof inspectSegments>>;
    try {
      r = await inspectSegments([subject], policy, { classifier: deps.classifier });
    } catch {
      throw new ThreadError('inspection_failed');
    }
    if (r.excluded && r.category === 'inspection_failed')
      throw new ThreadError('inspection_failed');
    value = r.excluded ? null : (r.segments[0] as string);
  }
  await getDb().execute(sql`
    UPDATE hub_thread SET subject_enc = ${value === null ? null : encryptContent(value)}
    WHERE id = ${threadId} AND locked_until IS NOT NULL AND locked_until >= now()
  `);
}

// ---------------------------------------------------------------------------------------------------------------
// Loading

async function userActive(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ status: user.status })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.status === 'active';
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

async function userSources(userId: string): Promise<Map<string, SourceRow>> {
  const rows = await getDb()
    .select({
      id: connectedSource.id,
      type: connectedSource.type,
      status: connectedSource.status,
      enabled: sql<boolean>`coalesce(${hubMailboxSetting.enabled}, false)`,
    })
    .from(connectedSource)
    .leftJoin(hubMailboxSetting, eq(hubMailboxSetting.sourceId, connectedSource.id))
    .where(eq(connectedSource.userId, userId));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Gmail lists every message under `_all`; Graph and IMAP refs use the stored folder (as `hub.backfill`). */
function refFor(type: SourceRow['type'], providerRef: string, folders: string[]): MailRef {
  return { providerRef, folderKey: type === 'gmail' ? '_all' : (folders[0] ?? '') };
}

interface FetchedThreadMessage {
  row: HubMessage;
  fetched: FetchedMessage;
}

type FetchResult =
  | { status: 'ok'; messages: FetchedThreadMessage[] }
  | { status: 'unavailable' }
  | { status: 'blocked'; code: 'fetch_unavailable' | 'source_auth' };

/**
 * Re-fetches every message through a connected hub-enabled source that holds it, trying the next such source when
 * one fails. A message no usable source holds, or that every provider reports gone, is skipped. A message that could
 * not be read because of the mailbox (auth, connection, rate limit) blocks the run: retry in 15 min.
 */
async function fetchThread(
  userId: string,
  rows: HubMessage[],
  deps: WorkerDeps,
): Promise<FetchResult> {
  const ctx = { userId };
  const all = await userSources(userId);
  const refs = await mail.listMessageSources(
    ctx,
    rows.map((r) => r.id),
  );
  const usable = (sourceId: string | null) => {
    const s = sourceId ? all.get(sourceId) : undefined;
    return s !== undefined && s.status === 'connected' && s.enabled;
  };
  const holders = new Map<string, typeof refs>();
  for (const r of refs) {
    if (!usable(r.sourceId)) continue;
    holders.set(r.messageId, [...(holders.get(r.messageId) ?? []), r]);
  }
  if (holders.size === 0) {
    const reconnect = refs.some((r) => {
      const s = r.sourceId ? all.get(r.sourceId) : undefined;
      return s?.status === 'needs_reconnection' && s.enabled;
    });
    return { status: 'blocked', code: reconnect ? 'source_auth' : 'fetch_unavailable' };
  }

  const got = new Map<string, FetchedMessage>();
  const blocked = new Map<string, 'fetch_unavailable' | 'source_auth'>();
  const sourceOrder = [...new Set([...holders.values()].flat().map((r) => r.sourceId!))];
  for (const sourceId of sourceOrder) {
    const wanted = [...holders.entries()]
      .filter(([messageId]) => !got.has(messageId))
      .flatMap(([messageId, list]) =>
        list.filter((r) => r.sourceId === sourceId).map((r) => ({ messageId, ref: r })),
      );
    if (wanted.length === 0) continue;
    const source = all.get(sourceId)!;
    let fetcher: MailFetcher | undefined;
    try {
      fetcher = await deps.openFetcher(sourceId);
      const res = await fetcher.fetchMessages(
        wanted.map((w) => refFor(source.type, w.ref.providerRef, w.ref.folders)),
      );
      for (const w of wanted) {
        const f = res.get(w.ref.providerRef);
        if (f instanceof MailAuthError) throw f;
        if (f === undefined || f instanceof Error) continue;
        got.set(w.messageId, f);
        blocked.delete(w.messageId);
      }
    } catch (err) {
      const code = err instanceof MailAuthError ? 'source_auth' : 'fetch_unavailable';
      if (err instanceof MailAuthError) await sources.markNeedsReconnection(sourceId, 'mail_auth');
      for (const w of wanted) if (!got.has(w.messageId)) blocked.set(w.messageId, code);
    } finally {
      await fetcher?.close().catch(() => undefined);
    }
  }
  if (blocked.size > 0) {
    return {
      status: 'blocked',
      code: [...blocked.values()].includes('source_auth') ? 'source_auth' : 'fetch_unavailable',
    };
  }
  const messages = rows
    .filter((r) => got.has(r.id))
    .map((row) => ({ row, fetched: got.get(row.id)! }));
  return messages.length === 0 ? { status: 'unavailable' } : { status: 'ok', messages };
}

/** People and companies the thread's participants already match, and projects linked to them (at most 30 each). */
async function knownRecords(userId: string, addresses: string[]) {
  const ctx = { userId };
  const people = new Map<string, string>();
  const companies = new Map<string, string>();
  for (const address of addresses) {
    const hash = addressHash(address);
    const email = await records.findEmailByHash(ctx, hash);
    if (email && !people.has(email.personId)) people.set(email.personId, hash);
    const domain = address.slice(address.lastIndexOf('@') + 1);
    if (domain === '' || isFreeMailDomain(domain)) continue;
    const dHash = domainHash(domain);
    const row = await records.findDomainByHash(ctx, dHash);
    if (row && !companies.has(row.companyId)) companies.set(row.companyId, dHash);
  }
  const projectIds = new Set<string>();
  for (const [kind, ids] of [
    ['person', [...people.keys()]],
    ['company', [...companies.keys()]],
  ] as const) {
    for (const l of await records.listLinksForRecords(ctx, kind, [...ids]))
      if (l.projectId) projectIds.add(l.projectId);
  }
  const named = async (
    kind: 'person' | 'company' | 'project',
    ids: string[],
    hashOf: (id: string) => string | null,
  ) =>
    (await records.getRecordsByIds(ctx, kind, ids.slice(0, 30))).map((r): HubPromptKnownRecord => ({
      id: r.id,
      name: decryptContent(r.nameEnc),
      hash: hashOf(r.id),
    }));
  return {
    people: await named('person', [...people.keys()], (id) => people.get(id) ?? null),
    companies: await named('company', [...companies.keys()], (id) => companies.get(id) ?? null),
    projects: await named('project', [...projectIds], () => null),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pipeline

interface ParsedThreadMessage {
  row: HubMessage;
  parsed: ParsedMessage;
  folders: string[];
  automatedReason: AutomatedReason | null;
}

const isHubError = (err: unknown): err is HubExtractionError | ThreadError =>
  err instanceof HubExtractionError || err instanceof ThreadError;

async function runThread(job: HubThreadJob, deps: WorkerDeps): Promise<HubThreadResult> {
  const { userId, threadId } = job.data;
  const ctx = { userId };
  const log = jobLogger(job.id ?? threadId, { userId, entityId: threadId });

  if (!(await userActive(userId))) {
    log.info({ status: 'aborted' });
    return { outcome: 'aborted' };
  }
  const thread = await mail.getThread(ctx, threadId);
  if (!thread) {
    log.info({ status: 'aborted' });
    return { outcome: 'aborted' };
  }
  const claimed = await claimThread(threadId);
  if (claimed === null) return { outcome: 'not_claimed' };

  const finish = (r: HubThreadResult): HubThreadResult => {
    const status = r.outcome === 'skipped' && r.skipReason ? `skipped_${r.skipReason}` : r.outcome;
    log.info({ status, errorCode: r.errorCode, counts: { version: claimed, ...(r.counts ?? {}) } });
    return r;
  };
  const skipped = async (
    reason: SkipReason,
    counts?: Record<string, number>,
  ): Promise<HubThreadResult> =>
    finish(
      (await skip(userId, threadId, claimed, reason))
        ? { outcome: 'skipped', skipReason: reason, counts }
        : { outcome: 'lease_lost', counts },
    );
  const released = async (code: HubThreadErrorCode, at: Date): Promise<HubThreadResult> =>
    finish({
      outcome: (await release(threadId, at, code)) ? 'released' : 'lease_lost',
      errorCode: code,
    });
  const failed = async (code: HubThreadErrorCode): Promise<HubThreadResult> =>
    finish({ outcome: await failAttempt(threadId, code), errorCode: code });

  // Rule 7: the daily cap counts threads with an extraction call in the last 24 h. Over it: next UTC midnight.
  const now = new Date();
  const cap = await getSetting('hub.daily_thread_cap_per_user');
  if ((await countExtractedThreadsSince(userId, new Date(now.getTime() - DAY_MS), threadId)) >= cap) {
    return released('daily_cap_reached', nextUtcMidnight(now));
  }

  let stage: 'prepare' | 'apply' = 'prepare';
  try {
    const rows = await mail.listMessages(ctx, threadId);
    const fetched = await fetchThread(userId, rows, deps);
    if (fetched.status === 'blocked')
      return released(fetched.code, new Date(Date.now() + HUB_REFETCH_DELAY_MS));
    if (fetched.status === 'unavailable') return skipped('unavailable');

    const messages: ParsedThreadMessage[] = [];
    for (const m of fetched.messages) {
      const parsed = await parseMessage(m.fetched.raw, {
        authored: m.row.direction === 'outbound',
        folders: m.fetched.folders,
      });
      const automated = classifyAutomated(parsed, m.fetched.folders);
      messages.push({
        row: m.row,
        parsed,
        folders: m.fetched.folders,
        automatedReason: automated.reason,
      });
    }
    const counts: Record<string, number> = {
      messages: messages.length,
      missing: rows.length - messages.length,
    };
    const direction = (m: ParsedThreadMessage) => m.row.direction as 'inbound' | 'outbound';

    if (
      threadIsAutomated(
        messages.map((m) => ({ direction: direction(m), automated: m.automatedReason !== null })),
      )
    ) {
      return skipped('automated', counts);
    }

    const ownerAddresses = await loadOwnAddresses(userId);
    const selection = selectParticipants(
      messages.map((m) => ({
        from: m.parsed.from,
        to: m.parsed.to,
        cc: m.parsed.cc,
        automated: m.automatedReason !== null,
      })),
      ownerAddresses,
      await ignoreRules.matcher(userId),
    );
    counts.participants = selection.participants.length;
    if (selection.skip) return skipped(selection.skip, counts);

    let policy: Policy;
    try {
      policy = (await loadPolicy(userId)).policy;
    } catch {
      throw new ThreadError('inspection_failed');
    }
    const inspectMessages: HubInspectMessage[] = messages.map((m) => {
      const cleaned = cleanHubBody(m.parsed);
      return {
        subject: m.parsed.subject,
        from: m.parsed.from,
        to: m.parsed.to,
        cc: m.parsed.cc,
        body: cleaned.body,
        signature: cleaned.signature,
        sentAt: m.parsed.date ?? m.row.sentAt,
        direction: direction(m),
        folders: m.folders,
      };
    });
    const inspectDeps = { policy, ownAddresses: ownerAddresses, classifier: deps.classifier };
    const inspection = await inspectThreadForExtraction(inspectMessages, inspectDeps);
    counts.excludedMessages = inspection.excludedMessages;
    if (inspection.status === 'excluded') return skipped('excluded', counts);

    const callCtx: HubCallContext = { userId, threadId };
    const sender = selection.participants.find((p) => p.sent && !p.owner);
    const senderKnown = sender
      ? (await records.findEmailByHash(ctx, addressHash(sender.address))) !== null
      : false;
    if (
      shouldTriage(
        selection,
        messages.map((m) => ({ direction: direction(m), automatedReason: m.automatedReason })),
        senderKnown,
      )
    ) {
      const first = messages[0]!.parsed;
      const verdict = await withLlmSlot(() =>
        triage(
          callCtx,
          {
            from: first.from,
            toCount: first.to.split(',').filter((t) => t.trim() !== '').length,
            headerNames: Object.keys(first.headers),
            first: inspectMessages[0]!,
          },
          { llm: deps.llm, ...inspectDeps },
        ),
      );
      if (verdict === 'automated_llm') return skipped('automated_llm', counts);
    }

    const participants = selection.participants.filter((p) => !p.ignored);
    const known = await knownRecords(
      userId,
      participants.filter((p) => !p.owner).map((p) => p.address),
    );
    const { output, calls } = await withLlmSlot(() =>
      extract(
        callCtx,
        {
          participants: toPromptParticipants(selection.participants),
          knownRecords: known,
          previousSummary: thread.summaryEnc ? decryptContent(thread.summaryEnc) : null,
          attachments: [],
          messages: inspection.messages,
        },
        { llm: deps.llm },
      ),
    );
    counts.llmCalls = calls;

    await storeSubject(threadId, messages[0]!.parsed.subject, policy, deps);

    stage = 'apply';
    const dates = messages
      .map((m) => (m.parsed.date ?? m.row.sentAt)?.getTime())
      .filter((t): t is number => t !== undefined);
    const ignored = await ignoreRules.list({ userId, role: 'user' });
    let result: ApplyResult;
    try {
      result = await applyExtraction(userId, threadId, claimed, output, {
        participants,
        ownerAddresses,
        ignoredAddresses: ignored.filter((r) => r.kind === 'address').map((r) => r.value),
        ignoredDomains: ignored.filter((r) => r.kind === 'domain').map((r) => r.value),
        promptVersion: HUB_EXTRACTION_PROMPT_VERSION,
        ...(dates.length > 0 ? { threadDate: new Date(Math.max(...dates)) } : {}),
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'inspection_unavailable')
        throw new ThreadError('inspection_failed');
      throw new ThreadError('apply_failed');
    }
    Object.assign(counts, {
      applied: result.applied,
      suggested: result.suggested,
      corroborated: result.corroborated,
      summaryStored: result.summaryStored ? 1 : 0,
      redactedValues: result.redactedValues,
    });
    return finish({ outcome: result.outcome, skipReason: result.skipReason, counts });
  } catch (err) {
    if (isHubError(err)) return failed(err.code);
    // An unexpected error before the apply (database, parser): back off like a failed apply, by code only.
    log.warn({ errorCode: toErrorCode(err), status: stage });
    return failed('apply_failed');
  }
}

export const handlers: HandlerMap = {
  'hub.thread': createHubThreadHandler(),
};

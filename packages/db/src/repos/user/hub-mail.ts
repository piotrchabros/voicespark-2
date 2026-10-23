import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb, type DbOrTx } from '../../client';
import {
  hubBlockMarker,
  hubFact,
  hubFactEvidence,
  hubIgnoreRule,
  hubLlmCall,
  hubMailboxSetting,
  hubMergeRedirect,
  hubMessage,
  hubMessageSource,
  hubThread,
  hubThreadRecord,
  hubThreadSource,
  type HubBlockMarker,
  type HubFact,
  type HubIgnoreRule,
  type HubMailboxSetting,
  type HubMessage,
  type HubMessageSource,
  type HubThread,
  type HubThreadRecord,
  type HubThreadSource,
} from '../../schema';
import type { UserContext } from './types';

export type HubRecordKind = 'person' | 'company' | 'project';

const MAX_REDIRECT_HOPS = 16;

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/** Null for ids owned by another user (the route audits the foreign access). */
export async function getThread(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<HubThread | null> {
  const [row] = await db
    .select()
    .from(hubThread)
    .where(and(eq(hubThread.id, threadId), eq(hubThread.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function getThreadByKey(
  ctx: UserContext,
  threadKey: string,
  db: DbOrTx = getDb(),
): Promise<HubThread | null> {
  const [row] = await db
    .select()
    .from(hubThread)
    .where(and(eq(hubThread.threadKey, threadKey), eq(hubThread.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function listThreadsByStatus(
  ctx: UserContext,
  status: HubThread['status'],
  limit: number,
  db: DbOrTx = getDb(),
): Promise<HubThread[]> {
  return db
    .select()
    .from(hubThread)
    .where(and(eq(hubThread.userId, ctx.userId), eq(hubThread.status, status)))
    .orderBy(desc(hubThread.lastMessageAt), asc(hubThread.id))
    .limit(limit);
}

/** Threads attached to a record through `hub_thread_record`, newest first. */
export async function listThreadsForRecord(
  ctx: UserContext,
  kind: HubRecordKind,
  recordId: string,
  limit: number,
  db: DbOrTx = getDb(),
): Promise<HubThread[]> {
  const col = recordColumn(kind);
  const rows = await db
    .select({ thread: hubThread })
    .from(hubThreadRecord)
    .innerJoin(hubThread, eq(hubThread.id, hubThreadRecord.threadId))
    .where(
      and(
        eq(hubThreadRecord.userId, ctx.userId),
        eq(hubThread.userId, ctx.userId),
        eq(col, recordId),
      ),
    )
    .orderBy(desc(hubThread.lastMessageAt), asc(hubThread.id))
    .limit(limit);
  return rows.map((r) => r.thread);
}

/** Moves a failed thread back to `pending` for an immediate re-claim; false when it is not failed. */
export async function retryFailedThread(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(hubThread)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: sql`now()`, lastErrorCode: null })
    .where(
      and(
        eq(hubThread.id, threadId),
        eq(hubThread.userId, ctx.userId),
        eq(hubThread.status, 'failed'),
      ),
    )
    .returning({ id: hubThread.id });
  return rows.length > 0;
}

export async function listMessages(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<HubMessage[]> {
  return db
    .select()
    .from(hubMessage)
    .where(and(eq(hubMessage.threadId, threadId), eq(hubMessage.userId, ctx.userId)))
    .orderBy(asc(hubMessage.sentAt), asc(hubMessage.id));
}

export async function getMessageByHash(
  ctx: UserContext,
  messageIdHash: string,
  db: DbOrTx = getDb(),
): Promise<HubMessage | null> {
  const [row] = await db
    .select()
    .from(hubMessage)
    .where(and(eq(hubMessage.messageIdHash, messageIdHash), eq(hubMessage.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Thread resolution by reference: the first existing message whose hash is among the given
 * in-reply-to / references hashes.
 */
export async function findMessageByHashes(
  ctx: UserContext,
  hashes: string[],
  db: DbOrTx = getDb(),
): Promise<HubMessage | null> {
  if (hashes.length === 0) return null;
  const [row] = await db
    .select()
    .from(hubMessage)
    .where(and(eq(hubMessage.userId, ctx.userId), inArray(hubMessage.messageIdHash, hashes)))
    .orderBy(asc(hubMessage.createdAt), asc(hubMessage.id))
    .limit(1);
  return row ?? null;
}

export async function listMessageSources(
  ctx: UserContext,
  messageIds: string[],
  db: DbOrTx = getDb(),
): Promise<HubMessageSource[]> {
  if (messageIds.length === 0) return [];
  return db
    .select()
    .from(hubMessageSource)
    .where(
      and(eq(hubMessageSource.userId, ctx.userId), inArray(hubMessageSource.messageId, messageIds)),
    )
    .orderBy(asc(hubMessageSource.createdAt), asc(hubMessageSource.id));
}

export async function listThreadSources(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<HubThreadSource[]> {
  return db
    .select()
    .from(hubThreadSource)
    .where(and(eq(hubThreadSource.threadId, threadId), eq(hubThreadSource.userId, ctx.userId)));
}

export async function listThreadRecords(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<HubThreadRecord[]> {
  return db
    .select()
    .from(hubThreadRecord)
    .where(and(eq(hubThreadRecord.threadId, threadId), eq(hubThreadRecord.userId, ctx.userId)));
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export async function getFact(
  ctx: UserContext,
  factId: string,
  db: DbOrTx = getDb(),
): Promise<HubFact | null> {
  const [row] = await db
    .select()
    .from(hubFact)
    .where(and(eq(hubFact.id, factId), eq(hubFact.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function listFactsByState(
  ctx: UserContext,
  state: HubFact['state'],
  limit: number,
  db: DbOrTx = getDb(),
): Promise<HubFact[]> {
  return db
    .select()
    .from(hubFact)
    .where(and(eq(hubFact.userId, ctx.userId), eq(hubFact.state, state)))
    .orderBy(desc(hubFact.createdAt), asc(hubFact.id))
    .limit(limit);
}

export async function listFactsForThread(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<HubFact[]> {
  return db
    .select()
    .from(hubFact)
    .where(and(eq(hubFact.threadId, threadId), eq(hubFact.userId, ctx.userId)))
    .orderBy(asc(hubFact.createdAt), asc(hubFact.id));
}

/** Facts in state `applied` or `overridden` for a record: the FR-018 source display. */
export async function listSourceFactsForRecord(
  ctx: UserContext,
  kind: HubRecordKind,
  recordId: string,
  db: DbOrTx = getDb(),
): Promise<HubFact[]> {
  const col = factRecordColumn(kind);
  return db
    .select()
    .from(hubFact)
    .where(
      and(
        eq(hubFact.userId, ctx.userId),
        eq(col, recordId),
        inArray(hubFact.state, ['applied', 'overridden']),
      ),
    )
    .orderBy(asc(hubFact.createdAt), asc(hubFact.id));
}

export async function pendingSuggestionCount(
  ctx: UserContext,
  db: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(hubFact)
    .where(and(eq(hubFact.userId, ctx.userId), eq(hubFact.state, 'suggested')));
  return row?.n ?? 0;
}

/** Extra evidence threads of a fact (corroboration). */
export async function listFactEvidenceThreadIds(
  ctx: UserContext,
  factId: string,
  db: DbOrTx = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ threadId: hubFactEvidence.threadId })
    .from(hubFactEvidence)
    .where(and(eq(hubFactEvidence.factId, factId), eq(hubFactEvidence.userId, ctx.userId)));
  return rows.map((r) => r.threadId);
}

// ---------------------------------------------------------------------------
// Block markers
// ---------------------------------------------------------------------------

export async function hasBlockMarker(
  ctx: UserContext,
  keyHash: string,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ keyHash: hubBlockMarker.keyHash })
    .from(hubBlockMarker)
    .where(and(eq(hubBlockMarker.userId, ctx.userId), eq(hubBlockMarker.keyHash, keyHash)))
    .limit(1);
  return !!row;
}

/** The subset of `keyHashes` that has a marker. */
export async function listBlockedKeyHashes(
  ctx: UserContext,
  keyHashes: string[],
  db: DbOrTx = getDb(),
): Promise<Set<string>> {
  if (keyHashes.length === 0) return new Set();
  const rows = await db
    .select({ keyHash: hubBlockMarker.keyHash })
    .from(hubBlockMarker)
    .where(and(eq(hubBlockMarker.userId, ctx.userId), inArray(hubBlockMarker.keyHash, keyHashes)));
  return new Set(rows.map((r) => r.keyHash));
}

export async function insertBlockMarker(
  ctx: UserContext,
  keyHash: string,
  reason: HubBlockMarker['reason'],
  db: DbOrTx = getDb(),
): Promise<void> {
  await db
    .insert(hubBlockMarker)
    .values({ userId: ctx.userId, keyHash, reason })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Ignore rules
// ---------------------------------------------------------------------------

export async function listIgnoreRules(
  ctx: UserContext,
  db: DbOrTx = getDb(),
): Promise<HubIgnoreRule[]> {
  return db
    .select()
    .from(hubIgnoreRule)
    .where(eq(hubIgnoreRule.userId, ctx.userId))
    .orderBy(asc(hubIgnoreRule.createdAt), asc(hubIgnoreRule.id));
}

/** The existing row on a duplicate `(kind, value_hash)`, so adding a rule twice is idempotent. */
export async function insertIgnoreRule(
  ctx: UserContext,
  input: { kind: 'address' | 'domain'; valueEnc: string; valueHash: string },
  db: DbOrTx = getDb(),
): Promise<HubIgnoreRule> {
  const [inserted] = await db
    .insert(hubIgnoreRule)
    .values({ userId: ctx.userId, ...input })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(hubIgnoreRule)
    .where(
      and(
        eq(hubIgnoreRule.userId, ctx.userId),
        eq(hubIgnoreRule.kind, input.kind),
        eq(hubIgnoreRule.valueHash, input.valueHash),
      ),
    )
    .limit(1);
  return existing!;
}

export async function deleteIgnoreRule(
  ctx: UserContext,
  ruleId: string,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(hubIgnoreRule)
    .where(and(eq(hubIgnoreRule.id, ruleId), eq(hubIgnoreRule.userId, ctx.userId)))
    .returning({ id: hubIgnoreRule.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Merge redirects
// ---------------------------------------------------------------------------

/**
 * Follows `hub_merge_redirect` to the kept record. Chained merges are re-pointed at merge time
 * (`recordMergeRedirect`), so this normally takes one hop; the loop is a bounded safety net.
 * Returns `id` itself when it was never merged away.
 */
export async function resolveRedirect(
  ctx: UserContext,
  kind: HubRecordKind,
  id: string,
  db: DbOrTx = getDb(),
): Promise<string> {
  let current = id;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    const [row] = await db
      .select({ toId: hubMergeRedirect.toId })
      .from(hubMergeRedirect)
      .where(
        and(
          eq(hubMergeRedirect.userId, ctx.userId),
          eq(hubMergeRedirect.kind, kind),
          eq(hubMergeRedirect.fromId, current),
        ),
      )
      .limit(1);
    if (!row || row.toId === current) return current;
    current = row.toId;
  }
  return current;
}

/**
 * Records `fromId -> toId` and re-points every redirect that already ended at `fromId`, so a
 * redirect never points at a deleted id. Call inside the merge transaction.
 */
export async function recordMergeRedirect(
  ctx: UserContext,
  kind: HubRecordKind,
  fromId: string,
  toId: string,
  db: DbOrTx = getDb(),
): Promise<void> {
  await db
    .update(hubMergeRedirect)
    .set({ toId })
    .where(
      and(
        eq(hubMergeRedirect.userId, ctx.userId),
        eq(hubMergeRedirect.kind, kind),
        eq(hubMergeRedirect.toId, fromId),
      ),
    );
  await db
    .insert(hubMergeRedirect)
    .values({ userId: ctx.userId, kind, fromId, toId, mergedAt: new Date() })
    .onConflictDoUpdate({
      target: [hubMergeRedirect.userId, hubMergeRedirect.kind, hubMergeRedirect.fromId],
      set: { toId, mergedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Mailbox settings
// ---------------------------------------------------------------------------

export async function listMailboxSettings(
  ctx: UserContext,
  db: DbOrTx = getDb(),
): Promise<HubMailboxSetting[]> {
  return db
    .select()
    .from(hubMailboxSetting)
    .where(eq(hubMailboxSetting.userId, ctx.userId))
    .orderBy(asc(hubMailboxSetting.createdAt), asc(hubMailboxSetting.sourceId));
}

export async function getMailboxSetting(
  ctx: UserContext,
  sourceId: string,
  db: DbOrTx = getDb(),
): Promise<HubMailboxSetting | null> {
  const [row] = await db
    .select()
    .from(hubMailboxSetting)
    .where(and(eq(hubMailboxSetting.sourceId, sourceId), eq(hubMailboxSetting.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function isMailboxEnabled(
  ctx: UserContext,
  sourceId: string,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  return (await getMailboxSetting(ctx, sourceId, db))?.enabled === true;
}

/** Turns the hub on for a mailbox; creates the row on first use. The source must be the caller's. */
export async function enableMailbox(
  ctx: UserContext,
  sourceId: string,
  consentTextVersion: string,
  db: DbOrTx = getDb(),
): Promise<HubMailboxSetting> {
  const now = new Date();
  const [row] = await db
    .insert(hubMailboxSetting)
    .values({
      sourceId,
      userId: ctx.userId,
      enabled: true,
      consentTextVersion,
      enabledAt: now,
      backfillState: 'pending',
    })
    .onConflictDoUpdate({
      target: hubMailboxSetting.sourceId,
      set: {
        enabled: true,
        consentTextVersion,
        enabledAt: now,
        disabledAt: null,
        dataChoice: null,
        backfillState: 'pending',
        backfillCursor: null,
        updatedAt: now,
      },
      setWhere: eq(hubMailboxSetting.userId, ctx.userId),
    })
    .returning();
  return row!;
}

/** Null when the mailbox has no setting row for this user. */
export async function disableMailbox(
  ctx: UserContext,
  sourceId: string,
  dataChoice: 'keep' | 'delete',
  db: DbOrTx = getDb(),
): Promise<HubMailboxSetting | null> {
  const now = new Date();
  const [row] = await db
    .update(hubMailboxSetting)
    .set({ enabled: false, disabledAt: now, dataChoice, updatedAt: now })
    .where(and(eq(hubMailboxSetting.sourceId, sourceId), eq(hubMailboxSetting.userId, ctx.userId)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// LLM call counters (counts only)
// ---------------------------------------------------------------------------

export async function countLlmCallsSince(
  ctx: UserContext,
  since: Date,
  purpose?: 'triage' | 'extract',
  db: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(hubLlmCall)
    .where(
      and(
        eq(hubLlmCall.userId, ctx.userId),
        gte(hubLlmCall.createdAt, since),
        purpose ? eq(hubLlmCall.purpose, purpose) : undefined,
      ),
    );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------

function recordColumn(kind: HubRecordKind) {
  if (kind === 'person') return hubThreadRecord.personId;
  if (kind === 'company') return hubThreadRecord.companyId;
  return hubThreadRecord.projectId;
}

function factRecordColumn(kind: HubRecordKind) {
  if (kind === 'person') return hubFact.personId;
  if (kind === 'company') return hubFact.companyId;
  return hubFact.projectId;
}

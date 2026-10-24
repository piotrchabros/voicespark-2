import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb, type DbOrTx, type Tx } from '../../client';
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

// ---------------------------------------------------------------------------
// Ingest writes (metadata only, SC-008). Callers hold the per-user ingest lock.
// ---------------------------------------------------------------------------

export interface LinkedThread {
  id: string;
  createdAt: Date;
}

/**
 * Threads a new message links to: those holding a message it references (`refHashes`: its
 * in-reply-to and references hashes) and those holding a message that references it (a reply
 * recorded before its parent). Oldest first.
 */
export async function findLinkedThreads(
  ctx: UserContext,
  messageIdHash: string,
  refHashes: string[],
  db: DbOrTx = getDb(),
): Promise<LinkedThread[]> {
  const byRef =
    refHashes.length > 0 ? sql` OR ${inArray(hubMessage.messageIdHash, refHashes)}` : sql``;
  return db
    .selectDistinct({ id: hubThread.id, createdAt: hubThread.createdAt })
    .from(hubMessage)
    .innerJoin(hubThread, eq(hubThread.id, hubMessage.threadId))
    .where(
      and(
        eq(hubMessage.userId, ctx.userId),
        sql`(${hubMessage.inReplyToHash} = ${messageIdHash}
          OR ${hubMessage.referencesHashes} @> ARRAY[${messageIdHash}::char(64)]${byRef})`,
      ),
    )
    .orderBy(asc(hubThread.createdAt), asc(hubThread.id));
}

/** A new thread at `version = 0`; {@link bumpThread} makes it 1. Returns the existing row on a key conflict. */
export async function insertThread(
  ctx: UserContext,
  threadKey: string,
  db: DbOrTx = getDb(),
): Promise<HubThread> {
  const [inserted] = await db
    .insert(hubThread)
    .values({ userId: ctx.userId, threadKey, version: 0 })
    .onConflictDoNothing()
    .returning();
  return inserted ?? (await getThreadByKey(ctx, threadKey, db))!;
}

/** Null when the `message_id_hash` is already known (the row is left as it is). */
export async function insertMessage(
  ctx: UserContext,
  values: {
    threadId: string;
    messageIdHash: string;
    inReplyToHash: string | null;
    referencesHashes: string[];
    sentAt: Date | null;
    direction: 'inbound' | 'outbound';
    isAutomated: boolean;
    automatedReason: string | null;
  },
  db: DbOrTx = getDb(),
): Promise<HubMessage | null> {
  const [row] = await db
    .insert(hubMessage)
    .values({ userId: ctx.userId, ...values })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Idempotent per `(source_id, provider_ref)`. */
export async function insertMessageSource(
  ctx: UserContext,
  values: { messageId: string; sourceId: string; providerRef: string; folders: string[] },
  db: DbOrTx = getDb(),
): Promise<void> {
  await db
    .insert(hubMessageSource)
    .values({ userId: ctx.userId, ...values })
    .onConflictDoNothing();
}

/** One row per `(thread, source)`; a later non-null link replaces an earlier one. */
export async function upsertThreadSource(
  ctx: UserContext,
  values: { threadId: string; sourceId: string; webLinkEnc: string | null },
  db: DbOrTx = getDb(),
): Promise<void> {
  const insert = db.insert(hubThreadSource).values({ userId: ctx.userId, ...values });
  const target = {
    target: [hubThreadSource.threadId, hubThreadSource.sourceId],
    where: sql`${hubThreadSource.sourceId} is not null`,
  };
  if (values.webLinkEnc === null) {
    await insert.onConflictDoNothing(target);
    return;
  }
  await insert.onConflictDoUpdate({
    target: target.target,
    targetWhere: target.where,
    set: { webLinkEnc: values.webLinkEnc },
  });
}

/**
 * A new message was recorded: `version + 1`, back to `pending` with the debounce, attempts reset,
 * message count and dates recomputed from the thread's messages. Returns the new version.
 */
export async function bumpThread(
  ctx: UserContext,
  threadId: string,
  debounceSeconds: number,
  db: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await db
    .update(hubThread)
    .set({
      version: sql`${hubThread.version} + 1`,
      status: 'pending',
      skipReason: null,
      attempts: 0,
      nextAttemptAt: sql`now() + make_interval(secs => ${debounceSeconds})`,
      messageCount: sql`(select count(*)::int from hub_message m where m.thread_id = ${hubThread.id})`,
      firstMessageAt: sql`(select min(m.sent_at) from hub_message m where m.thread_id = ${hubThread.id})`,
      lastMessageAt: sql`(select max(m.sent_at) from hub_message m where m.thread_id = ${hubThread.id})`,
    })
    .where(and(eq(hubThread.id, threadId), eq(hubThread.userId, ctx.userId)))
    .returning({ version: hubThread.version });
  return row!.version;
}

/**
 * Merges thread `fromId` into `intoId`: messages, sources, records, facts, evidence and LLM
 * counters move; rows the kept thread already has stay with it (a fact whose fingerprint the kept
 * thread already holds keeps the merged thread as extra evidence). Deletes `fromId`. Returns
 * whether the merged thread had a summary (the caller tombstones its document).
 */
export async function mergeThread(
  ctx: UserContext,
  intoId: string,
  fromId: string,
  db: DbOrTx = getDb(),
): Promise<{ hadSummary: boolean }> {
  const u = ctx.userId;
  await db.execute(
    sql`UPDATE hub_message SET thread_id = ${intoId} WHERE thread_id = ${fromId} AND user_id = ${u}`,
  );
  await db.execute(sql`
    UPDATE hub_thread_source s SET thread_id = ${intoId}
    WHERE s.thread_id = ${fromId} AND s.user_id = ${u}
      AND (s.source_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM hub_thread_source o WHERE o.thread_id = ${intoId} AND o.source_id = s.source_id))
  `);
  await db.execute(sql`
    UPDATE hub_thread_record r SET thread_id = ${intoId}
    WHERE r.thread_id = ${fromId} AND r.user_id = ${u}
      AND NOT EXISTS (
        SELECT 1 FROM hub_thread_record o
        WHERE o.thread_id = ${intoId}
          AND o.person_id IS NOT DISTINCT FROM r.person_id
          AND o.company_id IS NOT DISTINCT FROM r.company_id
          AND o.project_id IS NOT DISTINCT FROM r.project_id)
  `);
  await db.execute(sql`
    UPDATE hub_fact f SET thread_id = ${intoId}
    WHERE f.thread_id = ${fromId} AND f.user_id = ${u}
      AND NOT EXISTS (
        SELECT 1 FROM hub_fact o WHERE o.thread_id = ${intoId} AND o.fingerprint = f.fingerprint)
  `);
  await db.execute(sql`
    INSERT INTO hub_fact_evidence (fact_id, thread_id, user_id)
    SELECT id, ${intoId}::uuid, user_id FROM hub_fact WHERE thread_id = ${fromId} AND user_id = ${u}
    UNION
    SELECT fact_id, ${intoId}::uuid, user_id FROM hub_fact_evidence WHERE thread_id = ${fromId} AND user_id = ${u}
    ON CONFLICT DO NOTHING
  `);
  await db.execute(
    sql`UPDATE hub_llm_call SET thread_id = ${intoId} WHERE thread_id = ${fromId} AND user_id = ${u}`,
  );
  const [gone] = await db
    .delete(hubThread)
    .where(and(eq(hubThread.id, fromId), eq(hubThread.userId, u)))
    .returning({ summaryEnc: hubThread.summaryEnc });
  return { hadSummary: gone?.summaryEnc != null };
}

// ---------------------------------------------------------------------------
// Apply writes. Callers hold the per-user apply lock
// (`pg_advisory_xact_lock(hashtext('hub-apply:' || userId))`) in the same transaction.
// ---------------------------------------------------------------------------

/** Locks the thread row for the apply; `leaseHeld` is false once the worker's lease has expired. */
export async function lockThreadForApply(
  ctx: UserContext,
  threadId: string,
  tx: Tx,
): Promise<{ thread: HubThread; leaseHeld: boolean } | null> {
  const [row] = await tx
    .select({
      thread: hubThread,
      leaseHeld: sql<boolean>`(${hubThread.lockedUntil} is not null and ${hubThread.lockedUntil} >= now())`,
    })
    .from(hubThread)
    .where(and(eq(hubThread.id, threadId), eq(hubThread.userId, ctx.userId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

export type HubFactInsert = Omit<typeof hubFact.$inferInsert, 'id' | 'userId' | 'createdAt'>;

export async function getFactByThreadFingerprint(
  ctx: UserContext,
  threadId: string,
  fingerprint: string,
  db: DbOrTx = getDb(),
): Promise<HubFact | null> {
  const [row] = await db
    .select()
    .from(hubFact)
    .where(
      and(
        eq(hubFact.userId, ctx.userId),
        eq(hubFact.threadId, threadId),
        eq(hubFact.fingerprint, fingerprint),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Null on a `(thread_id, fingerprint)` duplicate: the finding is already stored for this thread. */
export async function insertFact(
  ctx: UserContext,
  values: HubFactInsert,
  db: DbOrTx = getDb(),
): Promise<HubFact | null> {
  const [row] = await db
    .insert(hubFact)
    .values({ ...values, userId: ctx.userId })
    .onConflictDoNothing({ target: [hubFact.threadId, hubFact.fingerprint] })
    .returning();
  return row ?? null;
}

/**
 * The newest `applied` or `overridden` fact behind the current value of a record field, or of a link role:
 * the target of a corroboration.
 */
export async function findCurrentValueFact(
  ctx: UserContext,
  target: { kind: HubRecordKind; recordId: string; field: string } | { linkId: string },
  db: DbOrTx = getDb(),
): Promise<HubFact | null> {
  const scope =
    'linkId' in target
      ? and(eq(hubFact.type, 'link_role'), eq(hubFact.linkId, target.linkId))
      : and(eq(hubFact.type, 'field'), eq(factRecordColumn(target.kind), target.recordId), eq(hubFact.field, target.field));
  const [row] = await db
    .select()
    .from(hubFact)
    .where(and(eq(hubFact.userId, ctx.userId), inArray(hubFact.state, ['applied', 'overridden']), scope))
    .orderBy(desc(hubFact.createdAt), desc(hubFact.id))
    .limit(1);
  return row ?? null;
}

/** Idempotent per `(fact_id, thread_id)`; true when the row is new. */
export async function insertFactEvidence(
  ctx: UserContext,
  factId: string,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(hubFactEvidence)
    .values({ factId, threadId, userId: ctx.userId })
    .onConflictDoNothing()
    .returning({ factId: hubFactEvidence.factId });
  return rows.length > 0;
}

/** Fingerprints of `rejected` facts that have this thread as their thread or as extra evidence. */
export async function listRejectedFingerprintsForThread(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<Set<string>> {
  const rows = await db
    .select({ fingerprint: hubFact.fingerprint })
    .from(hubFact)
    .where(
      and(
        eq(hubFact.userId, ctx.userId),
        eq(hubFact.state, 'rejected'),
        sql`(${hubFact.threadId} = ${threadId} or exists (
          select 1 from hub_fact_evidence e where e.fact_id = ${hubFact.id} and e.thread_id = ${threadId}))`,
      ),
    );
  return new Set(rows.map((r) => r.fingerprint));
}

/**
 * For each `(record, field)`: the newest message date of the thread behind the current `applied` email fact
 * (the fact's creation time when the thread is gone). Decides whether a new email value is newer.
 */
export async function latestAppliedFieldDates(
  ctx: UserContext,
  kind: HubRecordKind,
  recordIds: string[],
  fields: string[],
  db: DbOrTx = getDb(),
): Promise<{ recordId: string; field: string; at: Date }[]> {
  if (recordIds.length === 0 || fields.length === 0) return [];
  const col = factRecordColumn(kind);
  const rows = await db
    .select({
      recordId: col,
      field: hubFact.field,
      at: sql<Date>`max(coalesce(${hubThread.lastMessageAt}, ${hubFact.createdAt}))`.mapWith(
        (v: string | Date) => new Date(v),
      ),
    })
    .from(hubFact)
    .leftJoin(hubThread, eq(hubThread.id, hubFact.threadId))
    .where(
      and(
        eq(hubFact.userId, ctx.userId),
        eq(hubFact.type, 'field'),
        eq(hubFact.state, 'applied'),
        inArray(col, recordIds),
        inArray(hubFact.field, fields),
      ),
    )
    .groupBy(col, hubFact.field);
  return rows.map((r) => ({ recordId: r.recordId!, field: r.field!, at: r.at }));
}

/** Older `applied` email facts on a record field become `superseded`; `exceptFactId` is the new one. */
export async function supersedeFieldFacts(
  ctx: UserContext,
  kind: HubRecordKind,
  recordId: string,
  field: string,
  exceptFactId: string,
  db: DbOrTx = getDb(),
): Promise<number> {
  const rows = await db
    .update(hubFact)
    .set({ state: 'superseded' })
    .where(
      and(
        eq(hubFact.userId, ctx.userId),
        eq(hubFact.type, 'field'),
        eq(hubFact.state, 'applied'),
        eq(factRecordColumn(kind), recordId),
        eq(hubFact.field, field),
        sql`${hubFact.id} <> ${exceptFactId}`,
      ),
    )
    .returning({ id: hubFact.id });
  return rows.length;
}

/** Older `applied` role facts of a link become `superseded`. */
export async function supersedeLinkRoleFacts(
  ctx: UserContext,
  linkId: string,
  exceptFactId: string,
  db: DbOrTx = getDb(),
): Promise<number> {
  const rows = await db
    .update(hubFact)
    .set({ state: 'superseded' })
    .where(
      and(
        eq(hubFact.userId, ctx.userId),
        eq(hubFact.type, 'link_role'),
        eq(hubFact.state, 'applied'),
        eq(hubFact.linkId, linkId),
        sql`${hubFact.id} <> ${exceptFactId}`,
      ),
    )
    .returning({ id: hubFact.id });
  return rows.length;
}

/** Attaches the thread to a record; true when the row is new. */
export async function insertThreadRecord(
  ctx: UserContext,
  threadId: string,
  kind: HubRecordKind,
  recordId: string,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const rows = await db
    .insert(hubThreadRecord)
    .values({
      userId: ctx.userId,
      threadId,
      personId: kind === 'person' ? recordId : null,
      companyId: kind === 'company' ? recordId : null,
      projectId: kind === 'project' ? recordId : null,
    })
    .onConflictDoNothing()
    .returning({ id: hubThreadRecord.id });
  return rows.length > 0;
}

export async function countThreadRecords(
  ctx: UserContext,
  threadId: string,
  db: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(hubThreadRecord)
    .where(and(eq(hubThreadRecord.threadId, threadId), eq(hubThreadRecord.userId, ctx.userId)));
  return row?.n ?? 0;
}

/** Language and participants of a processed thread; with `summaryEnc` the summary is replaced (`summary_version + 1`). */
export async function storeThreadResult(
  ctx: UserContext,
  threadId: string,
  values: { language: 'pl' | 'en' | 'other'; participantsEnc: string; summaryEnc?: string },
  db: DbOrTx = getDb(),
): Promise<void> {
  await db
    .update(hubThread)
    .set({
      language: values.language,
      participantsEnc: values.participantsEnc,
      ...(values.summaryEnc === undefined
        ? {}
        : {
            summaryEnc: values.summaryEnc,
            summaryVersion: sql`${hubThread.summaryVersion} + 1`,
            summaryUpdatedAt: sql`now()`,
          }),
    })
    .where(and(eq(hubThread.id, threadId), eq(hubThread.userId, ctx.userId)));
}

/** Bumps `threads_processed` or `threads_skipped` and sets `last_run_at` on every hub mailbox of the thread. */
export async function bumpMailboxCounters(
  ctx: UserContext,
  threadId: string,
  outcome: 'done' | 'skipped',
  db: DbOrTx = getDb(),
): Promise<void> {
  await db
    .update(hubMailboxSetting)
    .set({
      ...(outcome === 'done'
        ? { threadsProcessed: sql`${hubMailboxSetting.threadsProcessed} + 1` }
        : { threadsSkipped: sql`${hubMailboxSetting.threadsSkipped} + 1` }),
      lastRunAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(hubMailboxSetting.userId, ctx.userId),
        sql`${hubMailboxSetting.sourceId} in (
          select s.source_id from hub_thread_source s
          where s.thread_id = ${threadId} and s.user_id = ${ctx.userId} and s.source_id is not null)`,
      ),
    );
}

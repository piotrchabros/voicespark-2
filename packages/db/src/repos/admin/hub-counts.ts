import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import {
  hubCompany,
  hubFact,
  hubFile,
  hubLlmCall,
  hubMailboxSetting,
  hubNote,
  hubPerson,
  hubProject,
  hubSyncItem,
  hubThread,
} from '../../schema';
import type { AdminHubAggregates, AdminHubCounts } from './types';

// Admin views of the Context Hub (FR-029, SC-011): `count(*)` and integer sums only. No encrypted
// column is ever selected here (constitution III).

const n = sql<number>`count(*)::int`;

/** Per-user hub counts for the admin user detail. */
export async function hubCountsForUser(userId: string): Promise<AdminHubCounts> {
  const db = getDb();
  const [people, companies, projects, notes, files, suggestions, syncFailed, mailboxes] =
    await Promise.all([
      db.select({ n }).from(hubPerson).where(eq(hubPerson.userId, userId)),
      db.select({ n }).from(hubCompany).where(eq(hubCompany.userId, userId)),
      db.select({ n }).from(hubProject).where(eq(hubProject.userId, userId)),
      db.select({ n }).from(hubNote).where(eq(hubNote.userId, userId)),
      db.select({ n }).from(hubFile).where(eq(hubFile.userId, userId)),
      db
        .select({ n })
        .from(hubFact)
        .where(and(eq(hubFact.userId, userId), eq(hubFact.state, 'suggested'))),
      db
        .select({ n })
        .from(hubSyncItem)
        .where(and(eq(hubSyncItem.userId, userId), eq(hubSyncItem.status, 'failed'))),
      db
        .select({ n })
        .from(hubMailboxSetting)
        .where(and(eq(hubMailboxSetting.userId, userId), eq(hubMailboxSetting.enabled, true))),
    ]);
  const c = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  return {
    recordCount: c(people) + c(companies) + c(projects),
    noteCount: c(notes),
    fileCount: c(files),
    pendingSuggestionCount: c(suggestions),
    syncFailedCount: c(syncFailed),
    hubMailboxCount: c(mailboxes),
  };
}

function utcMidnight(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** System-wide hub aggregates for admin health: LLM cost counters since UTC midnight, queue states. */
export async function hubAggregates(): Promise<AdminHubAggregates> {
  const db = getDb();
  const [[calls], [threads], [sync]] = await Promise.all([
    db
      .select({
        n,
        input: sql<number>`coalesce(sum(${hubLlmCall.inputTokens}), 0)::bigint`,
        output: sql<number>`coalesce(sum(${hubLlmCall.outputTokens}), 0)::bigint`,
      })
      .from(hubLlmCall)
      .where(gte(hubLlmCall.createdAt, utcMidnight())),
    db
      .select({
        pending: sql<number>`count(*) filter (where ${hubThread.status} = 'pending')::int`,
        failed: sql<number>`count(*) filter (where ${hubThread.status} = 'failed')::int`,
      })
      .from(hubThread),
    db.select({ n }).from(hubSyncItem).where(eq(hubSyncItem.status, 'failed')),
  ]);
  return {
    llmCallsToday: calls?.n ?? 0,
    inputTokensToday: Number(calls?.input ?? 0),
    outputTokensToday: Number(calls?.output ?? 0),
    threadsPending: threads?.pending ?? 0,
    threadsFailed: threads?.failed ?? 0,
    syncFailed: sync?.n ?? 0,
  };
}

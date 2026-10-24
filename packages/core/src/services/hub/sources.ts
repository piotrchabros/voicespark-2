import { z } from 'zod';
import { validateContactValue } from '@voicespark/filters';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb, hubThread, hubThreadSource, type HubFact, type HubThread } from '@voicespark/db';
import * as mail from '@voicespark/db/repos/user/hub-mail';
import { getRecord } from '@voicespark/db/repos/user/hub-records';
import type { ServiceContext } from '../../errors';
import { decryptContent, hubNotFound, type HubKind } from './common';

// Where a record's email-derived data came from (US3; contracts/http-api.md "GET /api/hub/{kind}/{id}/sources";
// FR-018, FR-019). The conversations are the threads of the record's `applied` or `overridden` facts plus the
// summaries attached through `hub_thread_record`. Nothing here is a body: subject, summary and participants are the
// stored, already filtered thread metadata.

/** Max attached summaries read per record; fact threads are read in full. */
const MAX_ATTACHED_THREADS = 200;

export type SourceSupport = { field: string } | { link: string } | { email: string } | { domain: string };

export interface SourceParticipant {
  name: string | null;
  address: string;
  owner: boolean;
}

export interface SourceThreadView {
  threadId: string;
  subject: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  participants: SourceParticipant[];
  summary: string | null;
  /** The provider "open original" link; none for IMAP. */
  openUrl: string | null;
  /** What of the record this conversation supports; empty for a summary-only attachment. */
  supports: SourceSupport[];
}

const decOpt = (blob: string | null): string | null => (blob === null ? null : decryptContent(blob));

function factValue(f: HubFact, key: string): string | null {
  if (f.valueEnc === null) return null;
  const v = JSON.parse(decryptContent(f.valueEnc)) as unknown;
  const s = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  return typeof s === 'string' ? s : null;
}

/** The record parts a fact supports; record-creation facts support the name plus the contact they created with. */
function supportsOf(f: HubFact): SourceSupport[] {
  switch (f.type) {
    case 'field':
      return f.field ? [{ field: f.field }] : [];
    case 'person': {
      // The address stored with the new person (applyPerson validates it the same way).
      const raw = factValue(f, 'email');
      const email = raw === null ? null : validateContactValue('email', raw);
      return email === null ? [{ field: 'name' }] : [{ field: 'name' }, { email }];
    }
    case 'company': {
      const raw = factValue(f, 'domain');
      const domain = raw === null ? null : validateContactValue('domain', raw);
      return domain === null ? [{ field: 'name' }] : [{ field: 'name' }, { domain }];
    }
    case 'project':
      return [{ field: 'name' }];
    case 'person_email': {
      const address = factValue(f, 'address');
      return address === null ? [] : [{ email: address }];
    }
    case 'company_domain': {
      const domain = factValue(f, 'domain');
      return domain === null ? [] : [{ domain }];
    }
    case 'link':
    case 'link_role':
      return f.linkId ? [{ link: f.linkId }] : [];
  }
}

function parseParticipants(blob: string | null): SourceParticipant[] {
  if (blob === null) return [];
  const parsed = JSON.parse(decryptContent(blob)) as unknown;
  if (!Array.isArray(parsed)) return [];
  const out: SourceParticipant[] = [];
  for (const p of parsed as unknown[]) {
    if (p === null || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    if (typeof r.address !== 'string') continue;
    out.push({ name: typeof r.name === 'string' ? r.name : null, address: r.address, owner: r.owner === true });
  }
  return out;
}

/** First stored provider link per thread. */
async function openUrls(ctx: ServiceContext, threadIds: string[]): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({ threadId: hubThreadSource.threadId, webLinkEnc: hubThreadSource.webLinkEnc })
    .from(hubThreadSource)
    .where(
      and(
        eq(hubThreadSource.userId, ctx.userId),
        inArray(hubThreadSource.threadId, threadIds),
        isNotNull(hubThreadSource.webLinkEnc),
      ),
    );
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.threadId)) map.set(r.threadId, decryptContent(r.webLinkEnc!));
  return map;
}

/** The conversations behind a record, newest first. A foreign or missing record is 404. */
export async function sourcesForRecord(
  ctx: ServiceContext,
  kind: HubKind,
  id: string,
): Promise<{ items: SourceThreadView[] }> {
  if (!z.uuid().safeParse(id).success) throw hubNotFound();
  if (!(await getRecord(ctx, kind, id))) throw hubNotFound();

  const [facts, attached] = await Promise.all([
    mail.listSourceFactsForRecord(ctx, kind, id),
    mail.listThreadsForRecord(ctx, kind, id, MAX_ATTACHED_THREADS),
  ]);
  const supports = new Map<string, Map<string, SourceSupport>>();
  for (const f of facts) {
    if (f.threadId === null) continue;
    const list = supports.get(f.threadId) ?? new Map<string, SourceSupport>();
    supports.set(f.threadId, list);
    for (const s of supportsOf(f)) list.set(JSON.stringify(s), s);
  }

  const threads = new Map<string, HubThread>(attached.map((t) => [t.id, t]));
  const missing = [...supports.keys()].filter((tid) => !threads.has(tid));
  if (missing.length > 0) {
    const rows = await getDb()
      .select()
      .from(hubThread)
      .where(and(eq(hubThread.userId, ctx.userId), inArray(hubThread.id, missing)));
    for (const t of rows) threads.set(t.id, t);
  }
  if (threads.size === 0) return { items: [] };

  const urls = await openUrls(ctx, [...threads.keys()]);
  const items = [...threads.values()]
    .sort(
      (a, b) =>
        (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(
      (t): SourceThreadView => ({
        threadId: t.id,
        subject: decOpt(t.subjectEnc),
        firstMessageAt: t.firstMessageAt?.toISOString() ?? null,
        lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
        messageCount: t.messageCount,
        participants: parseParticipants(t.participantsEnc),
        summary: decOpt(t.summaryEnc),
        openUrl: urls.get(t.id) ?? null,
        supports: [...(supports.get(t.id)?.values() ?? [])],
      }),
    );
  return { items };
}

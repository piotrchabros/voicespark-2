import { and, asc, count as countRows, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  getDb,
  hubBlockMarker,
  hubFact,
  hubFactEvidence,
  hubThread,
  withTransaction,
  type DbOrTx,
  type HubFact,
  type HubLink,
  type HubThread,
  type Tx,
} from '@voicespark/db';
import { insertBlockMarker } from '@voicespark/db/repos/user/hub-mail';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { AppError, type ServiceContext } from '../../errors';
import { markerKey } from '../../hub/fingerprint';
import { audit } from '../audit';
import { applyStoredFact, factLinkEnds, factTargetKind, type StoredFactTargets } from './apply';
import { decryptContent, type HubKind } from './common';

// The suggestion queue (US4; contracts/http-api.md "Suggestions", data-model.md "hub_fact" state machine; FR-015,
// FR-017, FR-023, FR-024). A suggestion is a `hub_fact` in state `suggested` whose target still exists: targets are
// `SET NULL`, so a fact whose record was deleted stays for diagnostics and drops out of the list and the count.
// A fact that needs a record still to be created carries `depends_on_fact_id` and is shown while that is pending.
// Decisions run one fact per transaction under the per-user apply lock, so they never interleave with an apply.

export type SuggestionTargetKind = HubKind | 'link';

export interface SuggestionSource {
  threadId: string;
  subject: string;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  evidence: string;
}

export interface SuggestionItem {
  id: string;
  type: HubFact['type'];
  target: { kind: SuggestionTargetKind; id: string | null; label: string | null };
  field: string | null;
  proposed: unknown;
  current: unknown;
  conflict: boolean;
  reason: HubFact['reason'];
  confidence: number;
  dependsOn: string | null;
  sources: SuggestionSource[];
  createdAt: string;
}

export interface SuggestionListQuery {
  state?: 'suggested';
  cursor?: string;
  limit?: number;
}

export interface DecideInput {
  ids: string[];
  action: 'accept' | 'reject';
}

export interface DecideResult {
  id: string;
  status: 'accepted' | 'rejected' | 'failed';
  errorCode?: string;
}

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
export const DECIDE_MAX_IDS = 200;
const FIELD_COLUMN: Record<string, 'roleTitleEnc' | 'phoneEnc' | 'industryEnc'> = {
  roleTitle: 'roleTitleEnc',
  phone: 'phoneEnc',
  industry: 'industryEnc',
};
const KINDS: HubKind[] = ['person', 'company', 'project'];

const listSchema = z
  .object({
    state: z.literal('suggested').optional(),
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
  })
  .strict();

const decideSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(DECIDE_MAX_IDS),
    action: z.enum(['accept', 'reject']),
  })
  .strict();

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
    throw new AppError('validation_failed', undefined, { fields });
  }
  return r.data;
}

/**
 * True for a suggestion still shown: its target exists, or the record it needs is itself a pending suggestion.
 * Record-creation facts have no target until they are accepted.
 */
const visible = sql`(case ${hubFact.type}
    when 'person_email' then ${hubFact.personId} is not null
    when 'company_domain' then ${hubFact.companyId} is not null
    when 'field' then coalesce(${hubFact.personId}, ${hubFact.companyId}, ${hubFact.projectId}) is not null
    when 'link' then num_nonnulls(${hubFact.personId}, ${hubFact.companyId}, ${hubFact.projectId}) >= 2
    when 'link_role' then ${hubFact.linkId} is not null
    else true end
  or exists (select 1 from hub_fact d where d.id = ${hubFact.dependsOnFactId} and d.state = 'suggested'))`;

const pending = (ctx: ServiceContext) => and(eq(hubFact.userId, ctx.userId), eq(hubFact.state, 'suggested'), visible);

const decOpt = (blob: string | null): string | null => (blob === null ? null : decryptContent(blob));

/** The JSON draft value of a fact; a value that is not JSON is returned as the stored text. */
function valueOf(blob: string | null): unknown {
  if (blob === null) return null;
  const text = decryptContent(blob);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const objectOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

const targetsOf = (f: HubFact): StoredFactTargets => ({
  personId: f.personId,
  companyId: f.companyId,
  projectId: f.projectId,
  linkId: f.linkId,
});

const recordIdOf = (f: Pick<HubFact, 'personId' | 'companyId' | 'projectId'>, kind: HubKind): string | null =>
  kind === 'person' ? f.personId : kind === 'company' ? f.companyId : f.projectId;

// ---------------------------------------------------------------------------------------------------------------
// List and count

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`s|${ts}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const ok =
    parts.length === 3 &&
    parts[0] === 's' &&
    !Number.isNaN(new Date(parts[1]!).getTime()) &&
    z.uuid().safeParse(parts[2]).success;
  if (!ok) throw new AppError('validation_failed', 'Invalid cursor', { fields: ['cursor'] });
  return [parts[1]!, parts[2]!];
}

async function threadsById(ctx: ServiceContext, ids: string[], db: DbOrTx): Promise<Map<string, HubThread>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(hubThread)
    .where(and(eq(hubThread.userId, ctx.userId), inArray(hubThread.id, ids)));
  return new Map(rows.map((t) => [t.id, t]));
}

/** The user's pending suggestions, newest first (keyset on `(created_at, id)`). Default limit 25, at most 100. */
export async function list(
  ctx: ServiceContext,
  query: SuggestionListQuery,
): Promise<{ items: SuggestionItem[]; nextCursor: string | null }> {
  const q = parse(listSchema, query);
  const limit = q.limit ?? LIST_DEFAULT_LIMIT;
  const conds = [pending(ctx)];
  if (q.cursor) {
    const [ts, id] = decodeCursor(q.cursor);
    conds.push(sql`(${hubFact.createdAt}, ${hubFact.id}) < (${ts}::timestamptz, ${id}::uuid)`);
  }
  const db = getDb();
  const rows = await db
    .select({ fact: hubFact, ts: sql<string>`${hubFact.createdAt}::text` })
    .from(hubFact)
    .where(and(...conds))
    .orderBy(desc(hubFact.createdAt), desc(hubFact.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last.ts, last.fact.id) : null;
  if (page.length === 0) return { items: [], nextCursor: null };
  const facts = page.map((r) => r.fact);

  // Records and links named by the page, decrypted once.
  const records = new Map<string, repo.HubRecordRow>();
  for (const kind of KINDS) {
    const ids = [...new Set(facts.map((f) => recordIdOf(f, kind)).filter((id): id is string => id !== null))];
    for (const r of ids.length ? await repo.getRecordsByIds(ctx, kind, ids, db) : []) records.set(`${kind}:${r.id}`, r);
  }
  const links = new Map<string, HubLink>();
  for (const id of new Set(facts.map((f) => f.linkId).filter((id): id is string => id !== null))) {
    const l = await repo.getLink(ctx, id, db);
    if (l) links.set(id, l);
  }
  const nameOf = (kind: HubKind, id: string | null): string | null => {
    const r = id ? records.get(`${kind}:${id}`) : undefined;
    return r ? decryptContent(r.nameEnc) : null;
  };

  // Sources: the fact's own thread first, then the corroborating threads.
  const extra = await db
    .select({ factId: hubFactEvidence.factId, threadId: hubFactEvidence.threadId })
    .from(hubFactEvidence)
    .where(and(eq(hubFactEvidence.userId, ctx.userId), inArray(hubFactEvidence.factId, facts.map((f) => f.id))));
  const threadIds = new Set<string>(extra.map((e) => e.threadId));
  for (const f of facts) if (f.threadId) threadIds.add(f.threadId);
  const threads = await threadsById(ctx, [...threadIds], db);

  const items = facts.map((f): SuggestionItem => {
    const value = valueOf(f.valueEnc);
    const draft = objectOf(value);
    const kind = factTargetKind(f);

    let target: SuggestionItem['target'];
    let current: unknown = null;
    if (kind === 'link') {
      const link = f.linkId ? links.get(f.linkId) : undefined;
      const ends = factLinkEnds((link?.kind ?? str(draft.kind) ?? 'person_company') as HubLink['kind'], {
        personId: link?.personId ?? f.personId,
        companyId: link?.companyId ?? f.companyId,
        projectId: link?.projectId ?? f.projectId,
        linkId: f.linkId,
      });
      const names = [nameOf(ends.a.kind, ends.a.id), nameOf(ends.b.kind, ends.b.id)].filter((n) => n !== null);
      target = { kind, id: link?.id ?? null, label: names.length ? names.join(' – ') : null };
      if (f.type === 'link_role') current = decOpt(link?.roleEnc ?? null);
    } else {
      const id = recordIdOf(f, kind);
      const record = id ? records.get(`${kind}:${id}`) : undefined;
      target = { kind, id: record ? id : null, label: record ? decryptContent(record.nameEnc) : str(draft.name) };
      const column = f.field ? FIELD_COLUMN[f.field] : undefined;
      if (f.type === 'field' && record && column) current = decOpt((record as Record<string, unknown>)[column] as string | null);
    }

    const proposed = f.type === 'field' ? (draft.value ?? value) : f.type === 'link_role' ? (draft.role ?? value) : value;
    const evidence = decOpt(f.evidenceEnc) ?? '';
    const sourceIds = [
      ...(f.threadId ? [f.threadId] : []),
      ...extra.filter((e) => e.factId === f.id && e.threadId !== f.threadId).map((e) => e.threadId),
    ];
    const sources = sourceIds.flatMap((tid): SuggestionSource[] => {
      const t = threads.get(tid);
      if (!t) return [];
      return [
        {
          threadId: t.id,
          subject: decOpt(t.subjectEnc) ?? '',
          firstMessageAt: t.firstMessageAt?.toISOString() ?? null,
          lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
          evidence: tid === f.threadId ? evidence : '',
        },
      ];
    });

    return {
      id: f.id,
      type: f.type,
      target,
      field: f.field,
      proposed,
      current,
      conflict: f.conflict,
      reason: f.reason,
      confidence: f.confidence,
      dependsOn: f.dependsOnFactId,
      sources,
      createdAt: f.createdAt.toISOString(),
    };
  });
  return { items, nextCursor };
}

/** The badge count (FR-024): pending suggestions, on the partial index `state = 'suggested'`. */
export async function count(ctx: ServiceContext): Promise<{ pending: number }> {
  const [row] = await getDb().select({ n: countRows() }).from(hubFact).where(pending(ctx));
  return { pending: row?.n ?? 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Decide

async function lockFact(ctx: ServiceContext, id: string, tx: Tx): Promise<HubFact | null> {
  const [row] = await tx
    .select()
    .from(hubFact)
    .where(and(eq(hubFact.id, id), eq(hubFact.userId, ctx.userId)))
    .for('update')
    .limit(1);
  return row ?? null;
}

async function isPending(ctx: ServiceContext, id: string, tx: Tx): Promise<boolean> {
  const rows = await tx
    .select({ id: hubFact.id })
    .from(hubFact)
    .where(and(eq(hubFact.id, id), pending(ctx)))
    .limit(1);
  return rows.length > 0;
}

/**
 * The block-marker keys of a fact (data-model.md "hub_block_marker"): `fact:{fingerprint}` plus the key of its
 * type. A rejection writes them; an accept removes them so the value is not tombstoned again.
 */
function markerKeysOf(f: HubFact): string[] {
  const draft = objectOf(valueOf(f.valueEnc));
  const keys = [markerKey.fact(f.fingerprint)];
  const add = (key: string | null) => {
    if (key) keys.push(key);
  };
  const s = (k: string) => str(draft[k]);
  switch (f.type) {
    case 'person':
      add(s('email') && markerKey.personEmail(s('email')!));
      break;
    case 'person_email':
      add(s('address') && markerKey.personEmail(s('address')!));
      break;
    case 'company':
      add(s('name') && markerKey.companyName(s('name')!));
      break;
    case 'company_domain':
      add(s('domain') && markerKey.companyDomain(s('domain')!));
      break;
    case 'project':
      add(s('name') && markerKey.projectName(s('name')!));
      break;
    case 'link': {
      const kind = s('kind') as HubLink['kind'] | null;
      if (kind === 'person_company' || kind === 'person_project' || kind === 'company_project') {
        const ends = factLinkEnds(kind, targetsOf(f));
        if (ends.a.id && ends.b.id) add(markerKey.link(kind, ends.a.id, ends.b.id));
      }
      break;
    }
    case 'field': {
      const kind = factTargetKind(f) as HubKind;
      const id = recordIdOf(f, kind);
      const value = s('value');
      if (id && f.field && value) add(markerKey.field(kind, id, f.field, value));
      break;
    }
    case 'link_role':
      break;
  }
  return keys;
}

/** Accepts `fact` and, first, the pending suggestion it depends on. Throws to roll the transaction back. */
async function acceptFact(ctx: ServiceContext, fact: HubFact, tx: Tx, decided: Map<string, DecideResult['status']>): Promise<void> {
  let f = fact;
  let dep: HubFact | null = null;
  if (f.dependsOnFactId) {
    dep = await lockFact(ctx, f.dependsOnFactId, tx);
    if (dep?.state === 'rejected') throw new AppError('suggestion_not_pending');
    if (dep?.state === 'suggested') {
      await acceptFact(ctx, dep, tx, decided);
      f = (await lockFact(ctx, f.id, tx))!;
      dep = await lockFact(ctx, dep.id, tx);
    }
  }
  // An end still missing is the record the applied dependency created.
  const own = targetsOf(f);
  const targets = dep
    ? {
        personId: own.personId ?? dep.personId,
        companyId: own.companyId ?? dep.companyId,
        projectId: own.projectId ?? dep.projectId,
        linkId: own.linkId,
      }
    : own;
  const row = await applyStoredFact(ctx, f, targets, tx);
  // The value cannot be written any more (an address now on another record, a record that is gone).
  if (!row) throw new AppError('conflict');
  const keys = markerKeysOf(row);
  await tx.delete(hubBlockMarker).where(and(eq(hubBlockMarker.userId, ctx.userId), inArray(hubBlockMarker.keyHash, keys)));
  // Dependents now point at the record this fact created.
  const kind = factTargetKind(row);
  if (kind !== 'link') {
    const id = recordIdOf(row, kind);
    const col = kind === 'person' ? hubFact.personId : kind === 'company' ? hubFact.companyId : hubFact.projectId;
    if (id) {
      await tx
        .update(hubFact)
        .set({ [kind === 'person' ? 'personId' : kind === 'company' ? 'companyId' : 'projectId']: id })
        .where(
          and(eq(hubFact.userId, ctx.userId), eq(hubFact.dependsOnFactId, row.id), eq(hubFact.state, 'suggested'), isNull(col)),
        );
    }
  }
  decided.set(row.id, 'accepted');
}

/** Rejects `fact` with its markers; its pending dependents become `rejected` without markers. */
async function rejectFact(ctx: ServiceContext, fact: HubFact, tx: Tx, decided: Map<string, DecideResult['status']>): Promise<void> {
  const now = new Date();
  await tx
    .update(hubFact)
    .set({ state: 'rejected', decidedAt: now })
    .where(and(eq(hubFact.id, fact.id), eq(hubFact.userId, ctx.userId)));
  for (const key of markerKeysOf(fact)) await insertBlockMarker(ctx, key, 'rejected', tx);
  decided.set(fact.id, 'rejected');
  let frontier = [fact.id];
  while (frontier.length > 0) {
    const rows = await tx
      .update(hubFact)
      .set({ state: 'rejected', decidedAt: now })
      .where(
        and(eq(hubFact.userId, ctx.userId), inArray(hubFact.dependsOnFactId, frontier), eq(hubFact.state, 'suggested')),
      )
      .returning({ id: hubFact.id });
    frontier = rows.map((r) => r.id);
    for (const id of frontier) decided.set(id, 'rejected');
  }
}

/** Requested ids with what they depend on first, so a parent is decided before its dependents. */
async function dependencyOrder(ctx: ServiceContext, ids: string[]): Promise<string[]> {
  const parent = new Map<string, string | null>();
  let frontier = [...new Set(ids)];
  while (frontier.length > 0) {
    const rows = await getDb()
      .select({ id: hubFact.id, dependsOn: hubFact.dependsOnFactId })
      .from(hubFact)
      .where(and(eq(hubFact.userId, ctx.userId), inArray(hubFact.id, frontier)))
      .orderBy(asc(hubFact.id));
    for (const r of rows) parent.set(r.id, r.dependsOn);
    frontier = rows.map((r) => r.dependsOn).filter((id): id is string => id !== null && !parent.has(id));
  }
  const depth = (id: string): number => {
    let n = 0;
    for (let p = parent.get(id) ?? null; p !== null && n <= parent.size; p = parent.get(p) ?? null) n += 1;
    return n;
  };
  const unique = [...new Set(ids)];
  return unique.map((id, i) => ({ id, i, d: depth(id) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.id);
}

/**
 * Accepts or rejects up to 200 suggestions. Each id runs in its own transaction under the per-user apply lock, in
 * dependency order: an accept applies the pending suggestion it depends on first; a reject writes the
 * `fact:{fingerprint}` and type markers and rejects the dependents (FR-017). Per-id results come back in the order
 * given; a fact no longer pending is `suggestion_not_pending`, another user's id `not_found`, and neither fails the
 * call. Audit `hub.suggestions_bulk_decided` with the counts.
 */
export async function decide(ctx: ServiceContext, input: DecideInput): Promise<{ results: DecideResult[] }> {
  const { ids, action } = parse(decideSchema, input);
  const done = new Map<string, DecideResult['status']>();
  const byId = new Map<string, DecideResult>();

  for (const id of await dependencyOrder(ctx, ids)) {
    const prior = done.get(id);
    if (prior) {
      byId.set(id, { id, status: prior });
      continue;
    }
    const decided = new Map<string, DecideResult['status']>();
    try {
      byId.set(
        id,
        await withTransaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hub-apply:' || ${ctx.userId}))`);
          const fact = await lockFact(ctx, id, tx);
          if (!fact) return { id, status: 'failed', errorCode: 'not_found' } satisfies DecideResult;
          if (fact.state !== 'suggested' || !(await isPending(ctx, id, tx))) {
            return { id, status: 'failed', errorCode: 'suggestion_not_pending' } satisfies DecideResult;
          }
          if (action === 'accept') await acceptFact(ctx, fact, tx, decided);
          else await rejectFact(ctx, fact, tx, decided);
          return { id, status: action === 'accept' ? 'accepted' : 'rejected' } satisfies DecideResult;
        }),
      );
      for (const [k, v] of decided) done.set(k, v);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      byId.set(id, { id, status: 'failed', errorCode: err.code });
    }
  }

  // Duplicate ids: the first occurrence decided, the rest found it no longer pending.
  const seen = new Set<string>();
  const results = ids.map((id): DecideResult => {
    if (seen.has(id)) return { id, status: 'failed', errorCode: 'suggestion_not_pending' };
    seen.add(id);
    return byId.get(id)!;
  });
  const tally = { accepted: 0, rejected: 0, failed: 0 };
  for (const r of results) tally[r.status] += 1;
  await audit.record({
    actorType: 'user',
    actorUserId: ctx.userId,
    action: 'hub.suggestions_bulk_decided',
    targetType: 'hub',
    metadata: tally,
  });
  return { results };
}

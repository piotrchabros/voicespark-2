import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  getDb,
  hubCompanyDomain,
  hubFact,
  hubFactEvidence,
  hubFile,
  hubLink,
  hubNote,
  hubPersonEmail,
  hubSearchDoc,
  hubThreadRecord,
  withTransaction,
  type DbOrTx,
  type HubFact,
  type HubLink,
  type Tx,
} from '@voicespark/db';
import * as content from '@voicespark/db/repos/user/hub-content';
import { recordMergeRedirect } from '@voicespark/db/repos/user/hub-mail';
import * as repo from '@voicespark/db/repos/user/hub-records';
import { recordTree } from '@voicespark/db/repos/user/hub-sync';
import { AppError, type ServiceContext } from '../../errors';
import { factFingerprint } from '../../hub/fingerprint';
import { audit } from '../audit';
import { decryptContent, hubNotFound, type HubKind } from './common';
import { reindex, type RecordView } from './records';
import { markRecordTree, tombstone } from './sync';

// Merge of two records of one kind (US4; contracts/http-api.md "merge-preview", "merge"; data-model.md
// "hub_merge_redirect" and the merge rules of "Provenance and owner_fields"; contracts/memory-store-hub.md "Merge";
// FR-005, AS4.3, AS4.4). The source record is merged into the kept one under the per-user apply lock, so a thread
// extraction never decides against a half-merged state. Kept values win, nulls take the source value, everything
// attached moves, facts are re-fingerprinted on the kept id, a redirect is written and no block markers are.

export interface MergePreview {
  moves: {
    emails: number;
    domains: number;
    notes: number;
    files: number;
    /** Links that move to the kept record. */
    links: number;
    /** Links to a record the kept one is already linked to: the kept row stays and takes the role when it has none. */
    linkDuplicates: number;
    summaries: number;
    facts: number;
  };
  /** Fields where both records have a different value: the kept value wins. */
  keptValues: string[];
  /** Fields the kept record lacks and takes from the source. */
  filledValues: string[];
}

const KINDS: HubKind[] = ['person', 'company', 'project'];

/** API field -> column, in display order. `name` and project `status` are never null. */
const FIELDS: Record<HubKind, [field: string, column: string][]> = {
  person: [
    ['name', 'nameEnc'],
    ['roleTitle', 'roleTitleEnc'],
    ['phone', 'phoneEnc'],
    ['description', 'descriptionEnc'],
  ],
  company: [
    ['name', 'nameEnc'],
    ['website', 'websiteEnc'],
    ['industry', 'industryEnc'],
    ['description', 'descriptionEnc'],
  ],
  project: [
    ['name', 'nameEnc'],
    ['status', 'status'],
    ['startDate', 'startDate'],
    ['endDate', 'endDate'],
    ['description', 'descriptionEnc'],
  ],
};

const NOTE_OWNER = { person: hubNote.personId, company: hubNote.companyId, project: hubNote.projectId };
const FILE_OWNER = { person: hubFile.personId, company: hubFile.companyId, project: hubFile.projectId };
const FACT_TARGET = { person: hubFact.personId, company: hubFact.companyId, project: hubFact.projectId };
const THREAD_TARGET = {
  person: hubThreadRecord.personId,
  company: hubThreadRecord.companyId,
  project: hubThreadRecord.projectId,
};
const LINK_END = { person: hubLink.personId, company: hubLink.companyId, project: hubLink.projectId };
const COLUMN_OF = { person: 'personId', company: 'companyId', project: 'projectId' } as const;

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/**
 * Both records of the user, or 404 for a missing or foreign id; 409 `merge_invalid` for the same id or a source of
 * another kind. Ownership is checked before the same-id rule, so a foreign id never answers 409.
 */
async function loadPair(
  ctx: ServiceContext,
  kind: HubKind,
  keptId: string,
  sourceId: string,
  db: DbOrTx,
  lock?: Tx,
): Promise<{ kept: repo.HubRecordRow; source: repo.HubRecordRow }> {
  if (!isUuid(keptId) || !isUuid(sourceId)) throw hubNotFound();
  const load = (id: string) => (lock ? repo.lockRecord(ctx, kind, id, lock) : repo.getRecord(ctx, kind, id, db));
  // Lock in id order so two opposite merges cannot deadlock.
  const [first, second] = keptId < sourceId ? [keptId, sourceId] : [sourceId, keptId];
  const rows = new Map<string, repo.HubRecordRow | null>();
  rows.set(first, await load(first));
  if (second !== first) rows.set(second, await load(second));
  const kept = rows.get(keptId);
  if (!kept) throw hubNotFound();
  if (keptId === sourceId) throw new AppError('merge_invalid');
  const source = rows.get(sourceId);
  if (!source) {
    for (const other of KINDS) {
      if (other !== kind && (await repo.getRecord(ctx, other, sourceId, db))) throw new AppError('merge_invalid');
    }
    throw hubNotFound();
  }
  return { kept, source };
}

const valueOf = (row: repo.HubRecordRow, column: string): unknown => (row as unknown as Record<string, unknown>)[column];

function plain(column: string, v: unknown): unknown {
  return typeof v === 'string' && column.endsWith('Enc') ? decryptContent(v) : v;
}

/** Field comparison of the two rows. */
function compareFields(kind: HubKind, kept: repo.HubRecordRow, source: repo.HubRecordRow) {
  const keptValues: string[] = [];
  const filled: [field: string, column: string][] = [];
  for (const [field, column] of FIELDS[kind]) {
    const k = valueOf(kept, column);
    const s = valueOf(source, column);
    if (s === null || s === undefined) continue;
    if (k === null || k === undefined) filled.push([field, column]);
    else if (plain(column, k) !== plain(column, s)) keptValues.push(field);
  }
  // A filled date must not break the date order of the kept project; such a fill is left out.
  if (kind === 'project') {
    const start = (filled.some(([f]) => f === 'startDate') ? valueOf(source, 'startDate') : valueOf(kept, 'startDate')) as
      | string
      | null;
    const end = (filled.some(([f]) => f === 'endDate') ? valueOf(source, 'endDate') : valueOf(kept, 'endDate')) as string | null;
    if (start && end && end < start) {
      const keptHasStart = valueOf(kept, 'startDate') !== null;
      const drop = keptHasStart ? 'endDate' : 'startDate';
      return { keptValues, filled: filled.filter(([f]) => f !== drop) };
    }
  }
  return { keptValues, filled };
}

/** The other end of a link seen from `kind`. */
function otherEnd(kind: HubKind, l: HubLink): { kind: HubKind; id: string } {
  for (const k of KINDS) {
    if (k === kind) continue;
    const id = l[COLUMN_OF[k]];
    if (id) return { kind: k, id };
  }
  throw new Error('hub_link without a second end');
}

async function splitLinks(ctx: ServiceContext, kind: HubKind, keptId: string, sourceId: string, db: DbOrTx) {
  const moves: HubLink[] = [];
  const duplicates: { source: HubLink; kept: HubLink }[] = [];
  for (const l of await repo.listLinksForRecord(ctx, kind, sourceId, db)) {
    const kept = await repo.findLinkBetween(ctx, { kind, id: keptId }, otherEnd(kind, l), db);
    if (kept) duplicates.push({ source: l, kept });
    else moves.push(l);
  }
  return { moves, duplicates };
}

async function countWhere(db: DbOrTx, table: typeof hubFact | typeof hubPersonEmail | typeof hubCompanyDomain, where: ReturnType<typeof and>) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  return row?.n ?? 0;
}

/** What a merge of `sourceId` into `keptId` would move and which values win. Writes nothing. */
export async function preview(
  ctx: ServiceContext,
  kind: HubKind,
  keptId: string,
  sourceId: string,
): Promise<MergePreview> {
  const db = getDb();
  const { kept, source } = await loadPair(ctx, kind, keptId, sourceId, db);
  const tree = await recordTree(ctx, kind, sourceId, db);
  const { moves, duplicates } = await splitLinks(ctx, kind, keptId, sourceId, db);
  const emails =
    kind === 'person'
      ? await countWhere(db, hubPersonEmail, and(eq(hubPersonEmail.userId, ctx.userId), eq(hubPersonEmail.personId, sourceId)))
      : 0;
  const domains =
    kind === 'company'
      ? await countWhere(
          db,
          hubCompanyDomain,
          and(eq(hubCompanyDomain.userId, ctx.userId), eq(hubCompanyDomain.companyId, sourceId)),
        )
      : 0;
  const facts = await countWhere(db, hubFact, and(eq(hubFact.userId, ctx.userId), eq(FACT_TARGET[kind], sourceId)));
  const { keptValues, filled } = compareFields(kind, kept, source);
  return {
    moves: {
      emails,
      domains,
      notes: tree.noteIds.length,
      files: tree.fileIds.length,
      links: moves.length,
      linkDuplicates: duplicates.length,
      summaries: tree.summaryThreadIds.length,
      facts,
    },
    keptValues,
    filledValues: filled.map(([f]) => f),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Facts

/**
 * The fingerprint of a stored fact with its current targets (contracts/hub-extraction.md section 10; the same
 * identity and value shape as `hub/policy.ts`). Null when an end is unknown and the stored one is kept.
 */
function refingerprint(userId: string, f: HubFact): string | null {
  const value = f.valueEnc === null ? {} : (JSON.parse(decryptContent(f.valueEnc)) as Record<string, unknown>);
  const payload = JSON.stringify({ field: f.type === 'link_role' ? null : f.field, ...value });
  if (f.type === 'link' || f.type === 'link_role') {
    const ends = KINDS.filter((k) => f[COLUMN_OF[k]] !== null);
    if (ends.length !== 2) return null;
    const [a, b] = ends as [HubKind, HubKind];
    return factFingerprint(userId, f.type, `${a}_${b}:${a}:${f[COLUMN_OF[a]]}:${b}:${f[COLUMN_OF[b]]}`, payload);
  }
  const kind = KINDS.find((k) => f[COLUMN_OF[k]] !== null);
  return kind ? factFingerprint(userId, f.type, `${kind}:${f[COLUMN_OF[kind]]}`, payload) : null;
}

/** Re-fingerprints the moved facts; one that now repeats a finding of its thread folds into the existing row. */
async function rekeyFacts(ctx: ServiceContext, factIds: string[], tx: Tx): Promise<void> {
  if (factIds.length === 0) return;
  const rows = await tx
    .select()
    .from(hubFact)
    .where(and(eq(hubFact.userId, ctx.userId), inArray(hubFact.id, factIds)));
  for (const f of rows) {
    const fp = refingerprint(ctx.userId, f);
    if (fp === null || fp === f.fingerprint) continue;
    const [dup] =
      f.threadId === null
        ? []
        : await tx
            .select({ id: hubFact.id })
            .from(hubFact)
            .where(and(eq(hubFact.threadId, f.threadId), eq(hubFact.fingerprint, fp), ne(hubFact.id, f.id)))
            .limit(1);
    if (!dup) {
      await tx.update(hubFact).set({ fingerprint: fp }).where(eq(hubFact.id, f.id));
      continue;
    }
    await tx.update(hubFact).set({ dependsOnFactId: dup.id }).where(eq(hubFact.dependsOnFactId, f.id));
    await tx.execute(sql`
      insert into hub_fact_evidence (fact_id, thread_id, user_id)
      select ${dup.id}, ${hubFactEvidence.threadId}, ${hubFactEvidence.userId} from hub_fact_evidence
      where ${hubFactEvidence.factId} = ${f.id}
      on conflict do nothing`);
    await tx.delete(hubFact).where(eq(hubFact.id, f.id));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Merge

/**
 * Merges `sourceId` into `keptId` in one transaction under `pg_advisory_xact_lock(hashtext('hub-apply:' || userId))`:
 * fields, emails or domains, notes, files, links, thread records and facts move; `hub_merge_redirect` gets the row
 * (chained redirects re-pointed); the source is deleted with its search row, the notes' and files' search rows are
 * re-owned and the kept row re-indexed; the source document is tombstoned and the kept tree marked dirty; audit
 * `hub.records_merged {kind}`. No block markers are written. 404 for a missing or foreign id, 409 `merge_invalid`
 * for the same id or another kind.
 */
export async function merge(
  ctx: ServiceContext,
  kind: HubKind,
  keptId: string,
  sourceId: string,
): Promise<{ record: RecordView }> {
  return withTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hub-apply:' || ${ctx.userId}))`);
    const { kept, source } = await loadPair(ctx, kind, keptId, sourceId, tx, tx);
    const { filled } = compareFields(kind, kept, source);
    const { moves, duplicates } = await splitLinks(ctx, kind, keptId, sourceId, tx);
    const factIds = (
      await tx
        .select({ id: hubFact.id })
        .from(hubFact)
        .where(and(eq(hubFact.userId, ctx.userId), eq(FACT_TARGET[kind], sourceId)))
    ).map((r) => r.id);

    // Before anything moves: the tombstone covers only the source document itself.
    await tombstone(tx, ctx.userId, kind, sourceId);

    if (kind === 'person') {
      const keptHasPrimary = (await repo.listEmails(ctx, keptId, tx)).some((e) => e.isPrimary);
      await tx
        .update(hubPersonEmail)
        .set({ personId: keptId, ...(keptHasPrimary ? { isPrimary: false } : {}) })
        .where(and(eq(hubPersonEmail.userId, ctx.userId), eq(hubPersonEmail.personId, sourceId)));
    } else if (kind === 'company') {
      await tx
        .update(hubCompanyDomain)
        .set({ companyId: keptId })
        .where(and(eq(hubCompanyDomain.userId, ctx.userId), eq(hubCompanyDomain.companyId, sourceId)));
    }
    const col = COLUMN_OF[kind];
    await tx
      .update(hubNote)
      .set({ [col]: keptId })
      .where(and(eq(hubNote.userId, ctx.userId), eq(NOTE_OWNER[kind], sourceId)));
    await tx
      .update(hubFile)
      .set({ [col]: keptId })
      .where(and(eq(hubFile.userId, ctx.userId), eq(FILE_OWNER[kind], sourceId)));

    for (const { source: s, kept: k } of duplicates) {
      if (k.roleEnc === null && s.roleEnc !== null) {
        await repo.updateLink(ctx, k.id, { roleEnc: s.roleEnc, roleOwnerSet: k.roleOwnerSet || s.roleOwnerSet }, tx);
      }
      await tx.update(hubFact).set({ linkId: k.id }).where(and(eq(hubFact.userId, ctx.userId), eq(hubFact.linkId, s.id)));
      await repo.deleteLink(ctx, s.id, tx);
    }
    if (moves.length > 0) {
      await tx
        .update(hubLink)
        .set({ [col]: keptId, updatedAt: new Date() })
        .where(and(eq(hubLink.userId, ctx.userId), eq(LINK_END[kind], sourceId)));
    }

    // Thread records: one per thread and record.
    await tx.execute(sql`
      delete from hub_thread_record s
      where s.user_id = ${ctx.userId} and ${sql.raw(`s.${kind}_id`)} = ${sourceId}
        and exists (select 1 from hub_thread_record k
                    where k.thread_id = s.thread_id and ${sql.raw(`k.${kind}_id`)} = ${keptId})`);
    await tx
      .update(hubThreadRecord)
      .set({ [col]: keptId })
      .where(and(eq(hubThreadRecord.userId, ctx.userId), eq(THREAD_TARGET[kind], sourceId)));

    await tx
      .update(hubFact)
      .set({ [col]: keptId })
      .where(and(eq(hubFact.userId, ctx.userId), eq(FACT_TARGET[kind], sourceId)));
    await rekeyFacts(ctx, factIds, tx);

    await recordMergeRedirect(ctx, kind, sourceId, keptId, tx);

    // Search rows of the merged-away record and of its notes and files (contracts/hub-search.md).
    await tx
      .update(hubSearchDoc)
      .set({ ownerId: keptId })
      .where(
        and(eq(hubSearchDoc.userId, ctx.userId), eq(hubSearchDoc.ownerKind, kind), eq(hubSearchDoc.ownerId, sourceId)),
      );
    await content.deleteSearchDoc(ctx, kind, sourceId, tx);
    if (!(await repo.deleteRecord(ctx, kind, sourceId, tx))) throw hubNotFound();

    const patch: Record<string, unknown> = {
      ownerFields: [...new Set([...kept.ownerFields, ...source.ownerFields])],
    };
    for (const [, column] of filled) patch[column] = valueOf(source, column);
    const updated = await repo.updateRecord(ctx, kind, keptId, patch as never, tx);
    if (!updated) throw hubNotFound();
    const record = await reindex(ctx, kind, updated, tx);

    await markRecordTree(tx, ctx.userId, kind, keptId);
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'hub.records_merged',
        targetType: 'hub',
        targetId: keptId,
        metadata: { kind },
      },
      tx,
    );
    return { record };
  });
}

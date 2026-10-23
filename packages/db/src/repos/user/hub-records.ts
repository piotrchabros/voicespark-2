import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type DbOrTx, type Tx } from '../../client';
import {
  hubCompany,
  hubCompanyDomain,
  hubLink,
  hubPerson,
  hubPersonEmail,
  hubProject,
  type HubCompany,
  type HubCompanyDomain,
  type HubLink,
  type HubPerson,
  type HubPersonEmail,
  type HubProject,
} from '../../schema';
import type { UserContext } from './types';

export type HubKind = 'person' | 'company' | 'project';
export type HubRecordRow = HubPerson | HubCompany | HubProject;

/** Hard cap on rows loaded for in-memory sorting by decrypted name. */
export const HUB_SORT_LIMIT = 10_000;

const RECORD_TABLES = {
  person: hubPerson,
  company: hubCompany,
  project: hubProject,
} as const;

type RecordTable = (typeof RECORD_TABLES)[HubKind];

function table(kind: HubKind): RecordTable {
  return RECORD_TABLES[kind];
}

// ---------------------------------------------------------------------------
// Records (person / company / project)
// ---------------------------------------------------------------------------

export interface HubSortRow {
  id: string;
  nameEnc: string;
  updatedAt: Date;
}

/** Loads id, name_enc and updated_at for at most 10,000 rows; the caller sorts after decrypting. */
export async function listForSort(
  ctx: UserContext,
  kind: HubKind,
  db: DbOrTx = getDb(),
): Promise<HubSortRow[]> {
  const t = table(kind);
  return db
    .select({ id: t.id, nameEnc: t.nameEnc, updatedAt: t.updatedAt })
    .from(t)
    .where(eq(t.userId, ctx.userId))
    .orderBy(desc(t.updatedAt), asc(t.id))
    .limit(HUB_SORT_LIMIT);
}

export async function countRecords(
  ctx: UserContext,
  kind: HubKind,
  db: DbOrTx = getDb(),
): Promise<number> {
  const t = table(kind);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(eq(t.userId, ctx.userId));
  return row?.n ?? 0;
}

export async function getRecord(
  ctx: UserContext,
  kind: HubKind,
  id: string,
  db: DbOrTx = getDb(),
): Promise<HubRecordRow | null> {
  const t = table(kind);
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.userId, ctx.userId)))
    .limit(1);
  return (row as HubRecordRow | undefined) ?? null;
}

export async function getRecordsByIds(
  ctx: UserContext,
  kind: HubKind,
  ids: string[],
  db: DbOrTx = getDb(),
): Promise<HubRecordRow[]> {
  if (ids.length === 0) return [];
  const t = table(kind);
  const rows = await db
    .select()
    .from(t)
    .where(and(inArray(t.id, ids), eq(t.userId, ctx.userId)));
  return rows as HubRecordRow[];
}

export async function lockRecord(
  ctx: UserContext,
  kind: HubKind,
  id: string,
  tx: Tx,
): Promise<HubRecordRow | null> {
  const t = table(kind);
  const [row] = await tx
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.userId, ctx.userId)))
    .limit(1)
    .for('update');
  return (row as HubRecordRow | undefined) ?? null;
}

/** Records whose normalised name key equals `nameKey` (similar-record warning, exact-name match). */
export async function findByNameKey(
  ctx: UserContext,
  kind: HubKind,
  nameKey: string,
  db: DbOrTx = getDb(),
): Promise<HubRecordRow[]> {
  const t = table(kind);
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.userId, ctx.userId), eq(t.nameKey, nameKey)))
    .orderBy(asc(t.createdAt), asc(t.id));
  return rows as HubRecordRow[];
}

/** Records whose looser match key equals `matchKey`. */
export async function findByMatchKey(
  ctx: UserContext,
  kind: HubKind,
  matchKey: string,
  db: DbOrTx = getDb(),
): Promise<HubRecordRow[]> {
  const t = table(kind);
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.userId, ctx.userId), eq(t.matchKey, matchKey)))
    .orderBy(asc(t.createdAt), asc(t.id));
  return rows as HubRecordRow[];
}

type RecordInsert =
  | typeof hubPerson.$inferInsert
  | typeof hubCompany.$inferInsert
  | typeof hubProject.$inferInsert;

/** `userId` is taken from `ctx`; any `userId` on `values` is overwritten. */
export async function insertRecord(
  ctx: UserContext,
  kind: HubKind,
  values: Omit<RecordInsert, 'userId'>,
  tx: Tx,
): Promise<HubRecordRow> {
  const t = table(kind);
  const [row] = await tx
    .insert(t)
    .values({ ...values, userId: ctx.userId } as never)
    .returning();
  return row as HubRecordRow;
}

/** Bumps `updated_at`; returns null when the record is not this user's. */
export async function updateRecord(
  ctx: UserContext,
  kind: HubKind,
  id: string,
  patch: Partial<Omit<RecordInsert, 'id' | 'userId' | 'createdAt'>>,
  tx: Tx,
): Promise<HubRecordRow | null> {
  const t = table(kind);
  const [row] = await tx
    .update(t)
    .set({ ...patch, updatedAt: sql`now()` } as never)
    .where(and(eq(t.id, id), eq(t.userId, ctx.userId)))
    .returning();
  return (row as HubRecordRow | undefined) ?? null;
}

export async function deleteRecord(
  ctx: UserContext,
  kind: HubKind,
  id: string,
  tx: Tx,
): Promise<boolean> {
  const t = table(kind);
  const rows = await tx
    .delete(t)
    .where(and(eq(t.id, id), eq(t.userId, ctx.userId)))
    .returning({ id: t.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Person emails
// ---------------------------------------------------------------------------

export async function listEmails(
  ctx: UserContext,
  personId: string,
  db: DbOrTx = getDb(),
): Promise<HubPersonEmail[]> {
  return db
    .select()
    .from(hubPersonEmail)
    .where(and(eq(hubPersonEmail.personId, personId), eq(hubPersonEmail.userId, ctx.userId)))
    .orderBy(desc(hubPersonEmail.isPrimary), asc(hubPersonEmail.createdAt), asc(hubPersonEmail.id));
}

export async function getEmail(
  ctx: UserContext,
  personId: string,
  emailId: string,
  db: DbOrTx = getDb(),
): Promise<HubPersonEmail | null> {
  const [row] = await db
    .select()
    .from(hubPersonEmail)
    .where(
      and(
        eq(hubPersonEmail.id, emailId),
        eq(hubPersonEmail.personId, personId),
        eq(hubPersonEmail.userId, ctx.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Exact address lookup through the keyed hash (unique per user). */
export async function findEmailByHash(
  ctx: UserContext,
  addressHash: string,
  db: DbOrTx = getDb(),
): Promise<HubPersonEmail | null> {
  const [row] = await db
    .select()
    .from(hubPersonEmail)
    .where(and(eq(hubPersonEmail.userId, ctx.userId), eq(hubPersonEmail.addressHash, addressHash)))
    .limit(1);
  return row ?? null;
}

/** Looser lookup through the match hash (e.g. plus-addressing and case folded away). */
export async function findEmailsByMatchHash(
  ctx: UserContext,
  matchHash: string,
  db: DbOrTx = getDb(),
): Promise<HubPersonEmail[]> {
  return db
    .select()
    .from(hubPersonEmail)
    .where(and(eq(hubPersonEmail.userId, ctx.userId), eq(hubPersonEmail.matchHash, matchHash)));
}

export async function insertEmail(
  ctx: UserContext,
  values: Omit<typeof hubPersonEmail.$inferInsert, 'userId'>,
  tx: Tx,
): Promise<HubPersonEmail> {
  const [row] = await tx
    .insert(hubPersonEmail)
    .values({ ...values, userId: ctx.userId })
    .returning();
  return row!;
}

export async function updateEmail(
  ctx: UserContext,
  emailId: string,
  patch: Partial<Pick<typeof hubPersonEmail.$inferInsert, 'isPrimary'>>,
  tx: Tx,
): Promise<HubPersonEmail | null> {
  const [row] = await tx
    .update(hubPersonEmail)
    .set(patch)
    .where(and(eq(hubPersonEmail.id, emailId), eq(hubPersonEmail.userId, ctx.userId)))
    .returning();
  return row ?? null;
}

export async function deleteEmail(ctx: UserContext, emailId: string, tx: Tx): Promise<boolean> {
  const rows = await tx
    .delete(hubPersonEmail)
    .where(and(eq(hubPersonEmail.id, emailId), eq(hubPersonEmail.userId, ctx.userId)))
    .returning({ id: hubPersonEmail.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Company domains
// ---------------------------------------------------------------------------

export async function listDomains(
  ctx: UserContext,
  companyId: string,
  db: DbOrTx = getDb(),
): Promise<HubCompanyDomain[]> {
  return db
    .select()
    .from(hubCompanyDomain)
    .where(and(eq(hubCompanyDomain.companyId, companyId), eq(hubCompanyDomain.userId, ctx.userId)))
    .orderBy(asc(hubCompanyDomain.createdAt), asc(hubCompanyDomain.id));
}

export async function getDomain(
  ctx: UserContext,
  companyId: string,
  domainId: string,
  db: DbOrTx = getDb(),
): Promise<HubCompanyDomain | null> {
  const [row] = await db
    .select()
    .from(hubCompanyDomain)
    .where(
      and(
        eq(hubCompanyDomain.id, domainId),
        eq(hubCompanyDomain.companyId, companyId),
        eq(hubCompanyDomain.userId, ctx.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findDomainByHash(
  ctx: UserContext,
  domainHash: string,
  db: DbOrTx = getDb(),
): Promise<HubCompanyDomain | null> {
  const [row] = await db
    .select()
    .from(hubCompanyDomain)
    .where(
      and(eq(hubCompanyDomain.userId, ctx.userId), eq(hubCompanyDomain.domainHash, domainHash)),
    )
    .limit(1);
  return row ?? null;
}

export async function insertDomain(
  ctx: UserContext,
  values: Omit<typeof hubCompanyDomain.$inferInsert, 'userId'>,
  tx: Tx,
): Promise<HubCompanyDomain> {
  const [row] = await tx
    .insert(hubCompanyDomain)
    .values({ ...values, userId: ctx.userId })
    .returning();
  return row!;
}

export async function deleteDomain(ctx: UserContext, domainId: string, tx: Tx): Promise<boolean> {
  const rows = await tx
    .delete(hubCompanyDomain)
    .where(and(eq(hubCompanyDomain.id, domainId), eq(hubCompanyDomain.userId, ctx.userId)))
    .returning({ id: hubCompanyDomain.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function linkEndColumn(kind: HubKind) {
  return kind === 'person'
    ? hubLink.personId
    : kind === 'company'
      ? hubLink.companyId
      : hubLink.projectId;
}

export async function getLink(
  ctx: UserContext,
  id: string,
  db: DbOrTx = getDb(),
): Promise<HubLink | null> {
  const [row] = await db
    .select()
    .from(hubLink)
    .where(and(eq(hubLink.id, id), eq(hubLink.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function lockLink(ctx: UserContext, id: string, tx: Tx): Promise<HubLink | null> {
  const [row] = await tx
    .select()
    .from(hubLink)
    .where(and(eq(hubLink.id, id), eq(hubLink.userId, ctx.userId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

/** Every link that touches the record, whichever end it sits on. */
export async function listLinksForRecord(
  ctx: UserContext,
  kind: HubKind,
  id: string,
  db: DbOrTx = getDb(),
): Promise<HubLink[]> {
  return db
    .select()
    .from(hubLink)
    .where(and(eq(hubLink.userId, ctx.userId), eq(linkEndColumn(kind), id)))
    .orderBy(asc(hubLink.createdAt), asc(hubLink.id));
}

export async function countLinksForRecord(
  ctx: UserContext,
  kind: HubKind,
  id: string,
  db: DbOrTx = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(hubLink)
    .where(and(eq(hubLink.userId, ctx.userId), eq(linkEndColumn(kind), id)));
  return row?.n ?? 0;
}

/** The existing link between two records, looked up from either end order. Null when absent. */
export async function findLinkBetween(
  ctx: UserContext,
  a: { kind: HubKind; id: string },
  b: { kind: HubKind; id: string },
  db: DbOrTx = getDb(),
): Promise<HubLink | null> {
  const ends: Partial<Record<HubKind, string>> = { [a.kind]: a.id, [b.kind]: b.id };
  if (a.kind === b.kind) return null;
  const conds = [eq(hubLink.userId, ctx.userId)];
  for (const k of ['person', 'company', 'project'] as const) {
    const col = linkEndColumn(k);
    conds.push(ends[k] ? eq(col, ends[k]!) : sql`${col} is null`);
  }
  const [row] = await db
    .select()
    .from(hubLink)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

export async function insertLink(
  ctx: UserContext,
  values: Omit<typeof hubLink.$inferInsert, 'userId'>,
  tx: Tx,
): Promise<HubLink> {
  const [row] = await tx
    .insert(hubLink)
    .values({ ...values, userId: ctx.userId })
    .returning();
  return row!;
}

export async function updateLink(
  ctx: UserContext,
  id: string,
  patch: Partial<Pick<typeof hubLink.$inferInsert, 'roleEnc' | 'roleOwnerSet'>>,
  tx: Tx,
): Promise<HubLink | null> {
  const [row] = await tx
    .update(hubLink)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(hubLink.id, id), eq(hubLink.userId, ctx.userId)))
    .returning();
  return row ?? null;
}

export async function deleteLink(ctx: UserContext, id: string, tx: Tx): Promise<boolean> {
  const rows = await tx
    .delete(hubLink)
    .where(and(eq(hubLink.id, id), eq(hubLink.userId, ctx.userId)))
    .returning({ id: hubLink.id });
  return rows.length > 0;
}

/** Links of any record in `ids` (used to load a page of records with their links in one query). */
export async function listLinksForRecords(
  ctx: UserContext,
  kind: HubKind,
  ids: string[],
  db: DbOrTx = getDb(),
): Promise<HubLink[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(hubLink)
    .where(and(eq(hubLink.userId, ctx.userId), inArray(linkEndColumn(kind), ids)));
}


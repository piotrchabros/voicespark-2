import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type DbOrTx, type Tx } from '../../client';
import {
  hubFile,
  hubNote,
  hubSearchDoc,
  type HubFile,
  type HubNote,
  type HubSearchDoc,
} from '../../schema';
import type { UserContext } from './types';

export type HubOwnerKind = 'person' | 'company' | 'project';
export type HubSearchItemType = 'person' | 'company' | 'project' | 'note' | 'file';

export type NewHubNote = Omit<typeof hubNote.$inferInsert, 'id' | 'userId'>;
export type HubNotePatch = Partial<
  Pick<NewHubNote, 'titleEnc' | 'bodyJsonEnc' | 'redactedValues' | 'updatedAt'>
>;
export type NewHubFile = Omit<typeof hubFile.$inferInsert, 'id' | 'userId'>;
export type HubFilePatch = Partial<
  Pick<
    NewHubFile,
    | 'nameEnc'
    | 'descriptionEnc'
    | 'extractionStatus'
    | 'extractionReason'
    | 'extractedTextEnc'
    | 'redactedValues'
    | 'updatedAt'
  >
>;

export interface UpsertSearchDocInput {
  itemType: HubSearchItemType;
  itemId: string;
  ownerKind: HubOwnerKind | null;
  ownerId: string | null;
  tokens: string[];
  updatedAt: Date;
}

export interface SearchCandidate {
  itemType: HubSearchItemType;
  itemId: string;
  ownerKind: HubOwnerKind | null;
  ownerId: string | null;
  updatedAt: Date;
}

/** Cap on candidates per query (contracts/hub-search.md). */
export const SEARCH_CANDIDATE_LIMIT = 200;

function ownerColumns(ownerKind: HubOwnerKind, ownerId: string) {
  return {
    personId: ownerKind === 'person' ? ownerId : null,
    companyId: ownerKind === 'company' ? ownerId : null,
    projectId: ownerKind === 'project' ? ownerId : null,
  };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function insertNote(
  ctx: UserContext,
  owner: { kind: HubOwnerKind; id: string },
  input: Omit<NewHubNote, 'personId' | 'companyId' | 'projectId'>,
  tx: Tx,
): Promise<HubNote> {
  const [row] = await tx
    .insert(hubNote)
    .values({ ...input, ...ownerColumns(owner.kind, owner.id), userId: ctx.userId })
    .returning();
  return row!;
}

export async function getNote(
  ctx: UserContext,
  noteId: string,
  db: DbOrTx = getDb(),
): Promise<HubNote | null> {
  const [row] = await db
    .select()
    .from(hubNote)
    .where(and(eq(hubNote.id, noteId), eq(hubNote.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function listNotesForOwner(
  ctx: UserContext,
  owner: { kind: HubOwnerKind; id: string },
  db: DbOrTx = getDb(),
): Promise<HubNote[]> {
  const col =
    owner.kind === 'person'
      ? hubNote.personId
      : owner.kind === 'company'
        ? hubNote.companyId
        : hubNote.projectId;
  return db
    .select()
    .from(hubNote)
    .where(and(eq(col, owner.id), eq(hubNote.userId, ctx.userId)))
    .orderBy(desc(hubNote.updatedAt), hubNote.id);
}

export async function getNotesByIds(
  ctx: UserContext,
  noteIds: string[],
  db: DbOrTx = getDb(),
): Promise<HubNote[]> {
  if (noteIds.length === 0) return [];
  return db
    .select()
    .from(hubNote)
    .where(and(eq(hubNote.userId, ctx.userId), sql`${hubNote.id} = ANY(${uuidArray(noteIds)})`));
}

export async function updateNote(
  ctx: UserContext,
  noteId: string,
  patch: HubNotePatch,
  tx: Tx,
): Promise<HubNote | null> {
  const [row] = await tx
    .update(hubNote)
    .set(patch)
    .where(and(eq(hubNote.id, noteId), eq(hubNote.userId, ctx.userId)))
    .returning();
  return row ?? null;
}

export async function deleteNote(ctx: UserContext, noteId: string, tx: Tx): Promise<boolean> {
  const rows = await tx
    .delete(hubNote)
    .where(and(eq(hubNote.id, noteId), eq(hubNote.userId, ctx.userId)))
    .returning({ id: hubNote.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function insertFile(
  ctx: UserContext,
  owner: { kind: HubOwnerKind; id: string },
  input: Omit<NewHubFile, 'personId' | 'companyId' | 'projectId'>,
  tx: Tx,
): Promise<HubFile> {
  const [row] = await tx
    .insert(hubFile)
    .values({ ...input, ...ownerColumns(owner.kind, owner.id), userId: ctx.userId })
    .returning();
  return row!;
}

export async function getFile(
  ctx: UserContext,
  fileId: string,
  db: DbOrTx = getDb(),
): Promise<HubFile | null> {
  const [row] = await db
    .select()
    .from(hubFile)
    .where(and(eq(hubFile.id, fileId), eq(hubFile.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function listFilesForOwner(
  ctx: UserContext,
  owner: { kind: HubOwnerKind; id: string },
  db: DbOrTx = getDb(),
): Promise<HubFile[]> {
  const col =
    owner.kind === 'person'
      ? hubFile.personId
      : owner.kind === 'company'
        ? hubFile.companyId
        : hubFile.projectId;
  return db
    .select()
    .from(hubFile)
    .where(and(eq(col, owner.id), eq(hubFile.userId, ctx.userId)))
    .orderBy(desc(hubFile.updatedAt), hubFile.id);
}

export async function getFilesByIds(
  ctx: UserContext,
  fileIds: string[],
  db: DbOrTx = getDb(),
): Promise<HubFile[]> {
  if (fileIds.length === 0) return [];
  return db
    .select()
    .from(hubFile)
    .where(and(eq(hubFile.userId, ctx.userId), sql`${hubFile.id} = ANY(${uuidArray(fileIds)})`));
}

export async function updateFile(
  ctx: UserContext,
  fileId: string,
  patch: HubFilePatch,
  tx: Tx,
): Promise<HubFile | null> {
  const [row] = await tx
    .update(hubFile)
    .set(patch)
    .where(and(eq(hubFile.id, fileId), eq(hubFile.userId, ctx.userId)))
    .returning();
  return row ?? null;
}

export async function deleteFile(ctx: UserContext, fileId: string, tx: Tx): Promise<boolean> {
  const rows = await tx
    .delete(hubFile)
    .where(and(eq(hubFile.id, fileId), eq(hubFile.userId, ctx.userId)))
    .returning({ id: hubFile.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Search index (blind token index, contracts/hub-search.md)
// ---------------------------------------------------------------------------

function sqlArray(values: string[], type: string) {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::${sql.raw(type)}`;
}

function uuidArray(values: string[]) {
  return sqlArray(values, 'uuid[]');
}

/** Same transaction as the domain write. Replaces the row for `(user, type, item)`. */
export async function upsertSearchDoc(
  ctx: UserContext,
  input: UpsertSearchDocInput,
  tx: Tx,
): Promise<void> {
  const tokens =
    input.tokens.length === 0
      ? sql`'{}'::char(16)[]`
      : sqlArray(input.tokens, 'char(16)[]');
  await tx
    .insert(hubSearchDoc)
    .values({
      userId: ctx.userId,
      itemType: input.itemType,
      itemId: input.itemId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      tokens: tokens as unknown as string[],
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: [hubSearchDoc.userId, hubSearchDoc.itemType, hubSearchDoc.itemId],
      set: {
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        tokens: tokens as unknown as string[],
        updatedAt: input.updatedAt,
      },
    });
}

/** Same transaction as the domain delete. */
export async function deleteSearchDoc(
  ctx: UserContext,
  itemType: HubSearchItemType,
  itemId: string,
  tx: Tx,
): Promise<void> {
  await tx
    .delete(hubSearchDoc)
    .where(
      and(
        eq(hubSearchDoc.userId, ctx.userId),
        eq(hubSearchDoc.itemType, itemType),
        eq(hubSearchDoc.itemId, itemId),
      ),
    );
}

/** Removes the index rows of every note and file under a record (record delete, same tx). */
export async function deleteSearchDocsForOwner(
  ctx: UserContext,
  ownerKind: HubOwnerKind,
  ownerId: string,
  tx: Tx,
): Promise<void> {
  await tx
    .delete(hubSearchDoc)
    .where(
      and(
        eq(hubSearchDoc.userId, ctx.userId),
        eq(hubSearchDoc.ownerKind, ownerKind),
        eq(hubSearchDoc.ownerId, ownerId),
      ),
    );
}

export async function getSearchDoc(
  ctx: UserContext,
  itemType: HubSearchItemType,
  itemId: string,
  db: DbOrTx = getDb(),
): Promise<HubSearchDoc | null> {
  const [row] = await db
    .select()
    .from(hubSearchDoc)
    .where(
      and(
        eq(hubSearchDoc.userId, ctx.userId),
        eq(hubSearchDoc.itemType, itemType),
        eq(hubSearchDoc.itemId, itemId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Candidate lookup: one statement, `tokens @>` (every query token, AND), optional type filter,
 * newest first, capped at 200. The caller decrypts and verifies; hash collisions are dropped there.
 */
export async function searchCandidates(
  ctx: UserContext,
  tokens: string[],
  types: HubSearchItemType[] | null | undefined,
  db: DbOrTx = getDb(),
): Promise<SearchCandidate[]> {
  if (tokens.length === 0) return [];
  const typeFilter = types && types.length > 0 ? sqlArray(types, 'text[]') : null;
  const result = await db.execute<{
    item_type: HubSearchItemType;
    item_id: string;
    owner_kind: HubOwnerKind | null;
    owner_id: string | null;
    updated_at: Date | string;
  }>(sql`
    SELECT item_type, item_id, owner_kind, owner_id, updated_at
    FROM hub_search_doc
    WHERE user_id = ${ctx.userId} AND tokens @> ${sqlArray(tokens, 'char(16)[]')}
      AND (${typeFilter}::text[] IS NULL OR item_type = ANY(${typeFilter}::text[]))
    ORDER BY updated_at DESC
    LIMIT ${SEARCH_CANDIDATE_LIMIT}
  `);
  return result.rows.map((r) => ({
    itemType: r.item_type,
    itemId: r.item_id,
    ownerKind: r.owner_kind,
    ownerId: r.owner_id,
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
  }));
}

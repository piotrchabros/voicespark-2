import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type DbOrTx, type Tx } from '../../client';
import {
  ownAnalysisPrompt,
  ownAnalysisPromptVersion,
  toneDefinitionVersion,
  type OwnAnalysisPrompt,
  type OwnAnalysisPromptVersion,
} from '../../schema';
import type { UserContext } from './types';

export interface OwnPromptVersionMeta {
  id: string;
  ownPromptId: string;
  versionNumber: number;
  charCount: number;
  basedOnDefinitionVersionId: string;
  basedOnVersionNumber: number;
  createdAt: Date;
}

export async function listOwnPrompts(
  ctx: UserContext,
  db: DbOrTx = getDb(),
): Promise<OwnAnalysisPrompt[]> {
  return db
    .select()
    .from(ownAnalysisPrompt)
    .where(eq(ownAnalysisPrompt.userId, ctx.userId))
    .orderBy(ownAnalysisPrompt.createdAt, ownAnalysisPrompt.id);
}

/** Null when this user has no own prompt for the definition. */
export async function getOwnPrompt(
  ctx: UserContext,
  definitionId: string,
  db: DbOrTx = getDb(),
): Promise<OwnAnalysisPrompt | null> {
  const [row] = await db
    .select()
    .from(ownAnalysisPrompt)
    .where(
      and(
        eq(ownAnalysisPrompt.definitionId, definitionId),
        eq(ownAnalysisPrompt.userId, ctx.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function lockOwnPrompt(
  ctx: UserContext,
  definitionId: string,
  tx: Tx,
): Promise<OwnAnalysisPrompt | null> {
  const [row] = await tx
    .select()
    .from(ownAnalysisPrompt)
    .where(
      and(
        eq(ownAnalysisPrompt.definitionId, definitionId),
        eq(ownAnalysisPrompt.userId, ctx.userId),
      ),
    )
    .limit(1)
    .for('update');
  return row ?? null;
}

/**
 * Inserts with `in_use = false`: the in-use CHECK needs a current version, which does not exist
 * yet. Insert the first version, then `setCurrentVersion` flips it on.
 */
export async function insertOwnPrompt(
  ctx: UserContext,
  definitionId: string,
  tx: Tx,
): Promise<OwnAnalysisPrompt> {
  const [row] = await tx
    .insert(ownAnalysisPrompt)
    .values({ userId: ctx.userId, definitionId, inUse: false })
    .returning();
  return row!;
}

/** Stores ciphertext as given. Returns the row, or throws when the own prompt is not the user's. */
export async function insertOwnPromptVersion(
  ctx: UserContext,
  input: {
    ownPromptId: string;
    promptTextEnc: string;
    charCount: number;
    basedOnDefinitionVersionId: string;
  },
  tx: Tx,
): Promise<OwnAnalysisPromptVersion> {
  const [owned] = await tx
    .select({ id: ownAnalysisPrompt.id })
    .from(ownAnalysisPrompt)
    .where(
      and(eq(ownAnalysisPrompt.id, input.ownPromptId), eq(ownAnalysisPrompt.userId, ctx.userId)),
    )
    .limit(1);
  if (!owned) throw new Error('own prompt not found for user');
  const [row] = await tx
    .insert(ownAnalysisPromptVersion)
    .values({
      ownPromptId: input.ownPromptId,
      versionNumber: sql`(select coalesce(max(${ownAnalysisPromptVersion.versionNumber}), 0) + 1 from ${ownAnalysisPromptVersion} where ${ownAnalysisPromptVersion.ownPromptId} = ${input.ownPromptId})`,
      promptTextEnc: input.promptTextEnc,
      charCount: input.charCount,
      basedOnDefinitionVersionId: input.basedOnDefinitionVersionId,
    })
    .returning();
  return row!;
}

/** Points the own prompt at `versionId` (which must belong to it) and switches it on. */
export async function setCurrentVersion(
  ctx: UserContext,
  ownPromptId: string,
  versionId: string,
  tx: Tx,
): Promise<void> {
  await tx
    .update(ownAnalysisPrompt)
    .set({ inUse: true, currentVersionId: versionId, updatedAt: new Date() })
    .where(
      and(
        eq(ownAnalysisPrompt.id, ownPromptId),
        eq(ownAnalysisPrompt.userId, ctx.userId),
        sql`exists (select 1 from ${ownAnalysisPromptVersion} where ${ownAnalysisPromptVersion.id} = ${versionId} and ${ownAnalysisPromptVersion.ownPromptId} = ${ownPromptId})`,
      ),
    );
}

export async function setInUse(
  ctx: UserContext,
  ownPromptId: string,
  inUse: boolean,
  tx: Tx,
): Promise<void> {
  await tx
    .update(ownAnalysisPrompt)
    .set({ inUse, updatedAt: new Date() })
    .where(and(eq(ownAnalysisPrompt.id, ownPromptId), eq(ownAnalysisPrompt.userId, ctx.userId)));
}

/** Newest first; never selects the ciphertext. */
export async function listVersionMeta(
  ctx: UserContext,
  ownPromptId: string,
  db: DbOrTx = getDb(),
): Promise<OwnPromptVersionMeta[]> {
  return db
    .select({
      id: ownAnalysisPromptVersion.id,
      ownPromptId: ownAnalysisPromptVersion.ownPromptId,
      versionNumber: ownAnalysisPromptVersion.versionNumber,
      charCount: ownAnalysisPromptVersion.charCount,
      basedOnDefinitionVersionId: ownAnalysisPromptVersion.basedOnDefinitionVersionId,
      basedOnVersionNumber: toneDefinitionVersion.versionNumber,
      createdAt: ownAnalysisPromptVersion.createdAt,
    })
    .from(ownAnalysisPromptVersion)
    .innerJoin(ownAnalysisPrompt, eq(ownAnalysisPrompt.id, ownAnalysisPromptVersion.ownPromptId))
    .innerJoin(
      toneDefinitionVersion,
      eq(toneDefinitionVersion.id, ownAnalysisPromptVersion.basedOnDefinitionVersionId),
    )
    .where(
      and(
        eq(ownAnalysisPromptVersion.ownPromptId, ownPromptId),
        eq(ownAnalysisPrompt.userId, ctx.userId),
      ),
    )
    .orderBy(desc(ownAnalysisPromptVersion.versionNumber));
}

/** Includes the ciphertext (`promptTextEnc`); the caller decrypts. */
export async function getVersionWithText(
  ctx: UserContext,
  versionId: string,
  db: DbOrTx = getDb(),
): Promise<
  (OwnAnalysisPromptVersion & { basedOnVersionNumber: number; definitionId: string }) | null
> {
  const [row] = await db
    .select({
      version: ownAnalysisPromptVersion,
      basedOnVersionNumber: toneDefinitionVersion.versionNumber,
      definitionId: ownAnalysisPrompt.definitionId,
    })
    .from(ownAnalysisPromptVersion)
    .innerJoin(ownAnalysisPrompt, eq(ownAnalysisPrompt.id, ownAnalysisPromptVersion.ownPromptId))
    .innerJoin(
      toneDefinitionVersion,
      eq(toneDefinitionVersion.id, ownAnalysisPromptVersion.basedOnDefinitionVersionId),
    )
    .where(
      and(eq(ownAnalysisPromptVersion.id, versionId), eq(ownAnalysisPrompt.userId, ctx.userId)),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...row.version,
    basedOnVersionNumber: row.basedOnVersionNumber,
    definitionId: row.definitionId,
  };
}

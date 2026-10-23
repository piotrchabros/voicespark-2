import { and, count, eq } from 'drizzle-orm';
import { getDb, type DbOrTx } from '../../client';
import { ownAnalysisPrompt, ownAnalysisPromptVersion, user } from '../../schema';

export interface InUseOwnPrompt {
  userId: string;
  ownPromptId: string;
  basedOnDefinitionVersionId: string;
}

/** In-use own prompts of active users for a definition. Metadata only: never selects prompt_text_enc. */
export async function listInUseForDefinition(
  db: DbOrTx,
  definitionId: string,
): Promise<InUseOwnPrompt[]> {
  return db
    .select({
      userId: ownAnalysisPrompt.userId,
      ownPromptId: ownAnalysisPrompt.id,
      basedOnDefinitionVersionId: ownAnalysisPromptVersion.basedOnDefinitionVersionId,
    })
    .from(ownAnalysisPrompt)
    .innerJoin(
      ownAnalysisPromptVersion,
      eq(ownAnalysisPromptVersion.id, ownAnalysisPrompt.currentVersionId),
    )
    .innerJoin(user, eq(user.id, ownAnalysisPrompt.userId))
    .where(
      and(
        eq(ownAnalysisPrompt.definitionId, definitionId),
        eq(ownAnalysisPrompt.inUse, true),
        eq(user.status, 'active'),
      ),
    );
}

/** definitionId -> number of in-use own prompts. */
export async function countInUseByDefinition(db: DbOrTx = getDb()): Promise<Map<string, number>> {
  const rows = await db
    .select({ definitionId: ownAnalysisPrompt.definitionId, n: count() })
    .from(ownAnalysisPrompt)
    .where(eq(ownAnalysisPrompt.inUse, true))
    .groupBy(ownAnalysisPrompt.definitionId);
  return new Map(rows.map((r) => [r.definitionId, Number(r.n)]));
}

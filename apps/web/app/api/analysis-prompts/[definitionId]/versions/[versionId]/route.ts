import * as ownPrompts from '@voicespark/core/services/own-prompts';
import { AppError, handle } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

export const GET = handle(
  async (_req, ctx: { params: Promise<{ definitionId: string; versionId: string }> }) => {
    const user = await requireUser();
    const { definitionId, versionId } = await ctx.params;
    try {
      return await ownPrompts.getVersion(user, definitionId, versionId);
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found')
        await auditForeignAccess(user, 'own_prompt_version', versionId);
      throw err;
    }
  },
);

import * as profiles from '@voicespark/core/services/profiles';
import { AppError, handle } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

export const GET = handle(
  async (_req, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    const user = await requireUser();
    const { id, versionId } = await ctx.params;
    try {
      return await profiles.version(user, id, versionId);
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found')
        await auditForeignAccess(user, 'profile', id);
      throw err;
    }
  },
);

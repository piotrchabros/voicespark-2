import { AppError } from '@voicespark/core/errors';
import * as profiles from '@voicespark/core/services/profiles';
import { handle } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

export const GET = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await profiles.getGeneration(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'profile_generation', id);
    throw err;
  }
});

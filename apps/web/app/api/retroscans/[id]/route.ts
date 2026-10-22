import { AppError } from '@voicespark/core/errors';
import * as retroscans from '@voicespark/core/services/retroscans';
import { auditForeignAccess, requireUser } from '../../../../lib/guards';
import { handle } from '../../../../lib/http';

export const GET = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await retroscans.get(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'retroscan', id);
    throw err;
  }
});

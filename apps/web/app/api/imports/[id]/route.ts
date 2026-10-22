import * as imports from '@voicespark/core/services/imports';
import { AppError, handle } from '../../../../lib/http';
import { auditForeignAccess, requireUser } from '../../../../lib/guards';

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await imports.getForUser(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'import_job', id);
    throw err;
  }
});

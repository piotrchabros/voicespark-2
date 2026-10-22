import * as sources from '@voicespark/core/services/sources';
import { AppError, handle } from '../../../../../lib/http';
import { auditForeignAccess, requireUser } from '../../../../../lib/guards';

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return { source: await sources.resume(user, id) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'source', id);
    throw err;
  }
});

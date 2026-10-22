import { AppError } from '@voicespark/core/errors';
import * as deletion from '@voicespark/core/services/deletion';
import { auditForeignAccess, requireUser } from '@/lib/guards';
import { handle } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await deletion.getForUser(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'deletion_request', id);
    throw err;
  }
});

import { AppError } from '@voicespark/core/errors';
import * as contentItems from '@voicespark/core/services/content-items';
import { auditForeignAccess, requireUser } from '@/lib/guards';
import { handle } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const DELETE = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return Response.json(await contentItems.remove(user, id), { status: 202 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'content_item', id);
    throw err;
  }
});

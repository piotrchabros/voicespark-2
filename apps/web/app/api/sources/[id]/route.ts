import * as sources from '@voicespark/core/services/sources';
import { auditForeignAccess, requireUser } from '../../../../lib/guards';
import { AppError, handle } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await sources.get(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'source', id);
    throw err;
  }
});

export const DELETE = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return Response.json(await sources.remove(user, id), { status: 202 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'source', id);
    throw err;
  }
});

import * as uploads from '@voicespark/core/services/uploads';
import { AppError, handle } from '@/lib/http';
import { auditForeignAccess, requireUser, type UserContext } from '@/lib/guards';

async function auditNotFound(user: UserContext, id: string, err: unknown): Promise<never> {
  if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'upload', id);
  throw err;
}

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await uploads.get(user, id);
  } catch (err) {
    return auditNotFound(user, id, err);
  }
});

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    const result = await uploads.remove(user, id);
    return Response.json(result, { status: 202 });
  } catch (err) {
    return auditNotFound(user, id, err);
  }
});

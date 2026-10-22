import { z } from 'zod';
import * as sources from '@voicespark/core/services/sources';
import { AppError, handle, parseJson } from '../../../../../lib/http';
import { auditForeignAccess, requireUser } from '../../../../../lib/guards';

const bodySchema = z.object({ deleteContent: z.boolean() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const { deleteContent } = await parseJson(req, bodySchema);
  try {
    return await sources.disconnect(user, id, deleteContent);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'source', id);
    throw err;
  }
});

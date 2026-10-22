import { z } from 'zod';
import { DRAFT_RATINGS } from '@voicespark/db';
import { AppError } from '@voicespark/core/errors';
import * as drafts from '@voicespark/core/services/drafts';
import { handle, parseJson } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

const bodySchema = z.object({ rating: z.enum(DRAFT_RATINGS) });

export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const { rating } = await parseJson(req, bodySchema);
  try {
    return { draft: await drafts.rate(user, id, rating) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'draft', id);
    throw err;
  }
});

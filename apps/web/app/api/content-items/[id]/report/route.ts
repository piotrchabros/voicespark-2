import { z } from 'zod';
import { FILTER_CATEGORIES } from '@voicespark/db';
import { AppError } from '@voicespark/core/errors';
import * as contentItems from '@voicespark/core/services/content-items';
import { auditForeignAccess, requireUser } from '../../../../../lib/guards';
import { handle, parseJson } from '../../../../../lib/http';

const bodySchema = z.object({ category: z.enum(FILTER_CATEGORIES).optional() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  // The body is optional: an empty body means no category.
  const raw = await req.text();
  const body: z.infer<typeof bodySchema> =
    raw.trim() === ''
      ? {}
      : await parseJson(new Request(req.url, { method: 'POST', body: raw }), bodySchema);
  try {
    const result = await contentItems.report(user, id, body.category);
    return Response.json(result, { status: 202 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'content_item', id);
    throw err;
  }
});

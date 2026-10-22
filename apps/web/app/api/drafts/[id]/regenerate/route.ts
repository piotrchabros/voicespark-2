import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as drafts from '@voicespark/core/services/drafts';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

const bodySchema = z.object({ feedback: z.string().max(drafts.FEEDBACK_MAX).optional() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  // Shares the create limit (D-D7).
  await rateLimit(`drafts:${user.userId}`, 20, 60);
  // The body is optional: an empty body means no feedback.
  const raw = await req.text();
  const body: z.infer<typeof bodySchema> =
    raw.trim() === ''
      ? {}
      : await parseJson(new Request(req.url, { method: 'POST', body: raw }), bodySchema);
  try {
    return Response.json(await drafts.regenerate(user, id, body.feedback), { status: 202 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'draft', id);
    throw err;
  }
});

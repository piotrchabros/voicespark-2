import { z } from 'zod';
import * as profiles from '@voicespark/core/services/profiles';
import { AppError, handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

const bodySchema = z.object({ feedback: z.string().min(1).max(profiles.FEEDBACK_MAX_CHARS) });

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const { feedback } = await parseJson(req, bodySchema);
  await rateLimit(`profile-gen:${user.userId}`, 10, 3600);
  try {
    return Response.json(await profiles.feedback(user, id, feedback), { status: 202 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'profile', id);
    throw err;
  }
});

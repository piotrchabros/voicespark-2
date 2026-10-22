import * as profiles from '@voicespark/core/services/profiles';
import { AppError, handle, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

export const POST = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`profile-gen:${user.userId}`, 10, 3600);
  try {
    return Response.json(await profiles.regenerate(user, id), { status: 202 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'profile', id);
    throw err;
  }
});

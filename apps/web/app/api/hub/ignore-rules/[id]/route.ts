import { AppError } from '@voicespark/core/errors';
import * as ignoreRules from '@voicespark/core/services/hub/ignore-rules';
import { handle, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`hub-ignore-rules:${user.userId}`, 60, 60);
  try {
    await ignoreRules.remove(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_ignore_rule', id);
    throw err;
  }
});

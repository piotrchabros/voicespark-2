import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as records from '@voicespark/core/services/hub/records';
import { handle, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string; domainId: string }> };

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  if (kindFromPath(params.kind) !== 'company') throw new AppError('not_found');
  await rateLimit(`hub-records:${user.userId}`, 120, 60);
  try {
    await records.removeDomain(user, 'company', params.id, params.domainId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_company', params.id);
    throw err;
  }
});

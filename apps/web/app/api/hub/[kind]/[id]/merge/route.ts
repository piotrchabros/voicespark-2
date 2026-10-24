import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as merge from '@voicespark/core/services/hub/merge';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string }> };

const bodySchema = z.object({ sourceId: z.string().min(1).max(64) }).strict();

// Merges `sourceId` into this record; kept values win, empty fields take the source value (FR-005).
export const POST = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  await rateLimit(`hub-records:${user.userId}`, 120, 60);
  const { sourceId } = await parseJson(req, bodySchema);
  try {
    return await merge.merge(user, kind, params.id, sourceId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      await auditForeignAccess(user, `hub_${kind}`, params.id);
      await auditForeignAccess(user, `hub_${kind}`, sourceId);
    }
    throw err;
  }
});

import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as merge from '@voicespark/core/services/hub/merge';
import { handle } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string }> };

// What merging `sourceId` into this record would move and which values win (FR-005).
export const GET = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  const sourceId = new URL(req.url).searchParams.get('sourceId');
  if (!sourceId) throw new AppError('validation_failed', undefined, { fields: ['sourceId'] });
  try {
    return await merge.preview(user, kind, params.id, sourceId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      await auditForeignAccess(user, `hub_${kind}`, params.id);
      await auditForeignAccess(user, `hub_${kind}`, sourceId);
    }
    throw err;
  }
});

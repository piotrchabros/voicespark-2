import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import { sourcesForRecord } from '@voicespark/core/services/hub/sources';
import { handle } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string }> };

// The conversations behind a record's email-derived data and its attached summaries (FR-018, FR-019).
export const GET = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  try {
    return await sourcesForRecord(user, kind, params.id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});

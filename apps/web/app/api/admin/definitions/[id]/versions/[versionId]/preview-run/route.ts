import * as analysisPreview from '@voicespark/core/services/analysis-preview';
import { handle, rateLimit } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

type Ctx = { params: Promise<{ id: string; versionId: string }> };

// A real model run on the built-in synthetic samples (FR-004). Writes nothing to the database.
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const admin = await requireAdmin();
  await rateLimit(`admin-preview-run:${admin.userId}`, 10, 3600);
  const { id, versionId } = await ctx.params;
  return adminJson(
    'POST /api/admin/definitions/[id]/versions/[versionId]/preview-run',
    await analysisPreview.startPreviewRun(admin.userId, id, versionId),
    202,
  );
});

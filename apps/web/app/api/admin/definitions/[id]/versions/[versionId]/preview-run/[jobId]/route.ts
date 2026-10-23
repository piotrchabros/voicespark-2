import * as analysisPreview from '@voicespark/core/services/analysis-preview';
import { handle } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

type Ctx = { params: Promise<{ id: string; versionId: string; jobId: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  await requireAdmin();
  const { id, versionId, jobId } = await ctx.params;
  return adminJson(
    'GET /api/admin/definitions/[id]/versions/[versionId]/preview-run/[jobId]',
    await analysisPreview.getPreviewRun(id, versionId, jobId),
  );
});

import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../../../lib/guards';
import { handle } from '../../../../../../../../lib/http';

export const POST = handle(
  async (_req, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    const admin = await requireAdmin();
    const { id, versionId } = await ctx.params;
    const prompt = await prompts.publish(admin.userId, id, versionId);
    return adminJson('POST /api/admin/prompts/[id]/versions/[versionId]/publish', { prompt });
  },
);

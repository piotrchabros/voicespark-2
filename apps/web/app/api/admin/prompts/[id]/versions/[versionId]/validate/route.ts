import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../../../lib/guards';
import { handle } from '../../../../../../../../lib/http';

export const POST = handle(
  async (_req, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    await requireAdmin();
    const { versionId } = await ctx.params;
    return adminJson(
      'POST /api/admin/prompts/[id]/versions/[versionId]/validate',
      await prompts.validate(versionId),
    );
  },
);

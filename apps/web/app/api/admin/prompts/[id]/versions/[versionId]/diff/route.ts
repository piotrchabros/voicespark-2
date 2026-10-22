import { z } from 'zod';
import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../../../lib/guards';
import { handle } from '../../../../../../../../lib/http';

const againstSchema = z.uuid();

export const GET = handle(
  async (req, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    await requireAdmin();
    const { id, versionId } = await ctx.params;
    const against = againstSchema.parse(new URL(req.url).searchParams.get('against'));
    return adminJson(
      'GET /api/admin/prompts/[id]/versions/[versionId]/diff',
      await prompts.diff(id, versionId, against),
    );
  },
);

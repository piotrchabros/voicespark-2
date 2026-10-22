import { z } from 'zod';
import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../../../lib/guards';
import { handle, parseJson } from '../../../../../../../../lib/http';

const previewBody = z.strictObject({ isRevision: z.boolean().optional() });

export const POST = handle(
  async (req, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    await requireAdmin();
    const { versionId } = await ctx.params;
    // The body is optional.
    const text = await req.text();
    const body =
      text.trim() === ''
        ? {}
        : await parseJson(new Request(req.url, { method: 'POST', body: text }), previewBody);
    const opts = body.isRevision === undefined ? {} : { isRevision: body.isRevision };
    return adminJson(
      'POST /api/admin/prompts/[id]/versions/[versionId]/preview',
      await prompts.preview(versionId, opts),
    );
  },
);

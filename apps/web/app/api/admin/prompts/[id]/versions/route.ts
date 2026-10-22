import { z } from 'zod';
import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../lib/guards';
import { handle, parseJson } from '../../../../../../lib/http';

const draftBody = z.strictObject({ fromVersionId: z.uuid().optional() });

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  // The body is optional: an empty request creates a draft from the active version.
  const text = await req.text();
  const body =
    text.trim() === ''
      ? {}
      : await parseJson(new Request(req.url, { method: 'POST', body: text }), draftBody);
  const version = await prompts.createDraft(admin.userId, id, body.fromVersionId);
  return adminJson('POST /api/admin/prompts/[id]/versions', { version }, 201);
});

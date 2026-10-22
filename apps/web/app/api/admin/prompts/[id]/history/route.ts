import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../lib/guards';
import { handle } from '../../../../../../lib/http';

export const GET = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdmin();
  const { id } = await ctx.params;
  return adminJson('GET /api/admin/prompts/[id]/history', await prompts.history(id));
});

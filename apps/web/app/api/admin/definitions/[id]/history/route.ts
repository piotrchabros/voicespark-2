import * as definitions from '@voicespark/core/services/definitions';
import { handle } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdmin();
  const { id } = await ctx.params;
  return adminJson('GET /api/admin/definitions/[id]/history', await definitions.history(id));
});

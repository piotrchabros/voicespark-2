import { z } from 'zod';
import * as definitions from '@voicespark/core/services/definitions';
import { handle, parseJson } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

const bodySchema = z.object({ versionId: z.uuid() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const { versionId } = await parseJson(req, bodySchema);
  const definition = await definitions.rollback(admin.userId, id, versionId);
  return adminJson('POST /api/admin/definitions/[id]/rollback', { definition });
});

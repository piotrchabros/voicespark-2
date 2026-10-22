import { z } from 'zod';
import { DEFINITION_AVAILABILITIES } from '@voicespark/db';
import * as definitions from '@voicespark/core/services/definitions';
import { handle, parseJson } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

const bodySchema = z.object({ availability: z.enum(DEFINITION_AVAILABILITIES) });

export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const { availability } = await parseJson(req, bodySchema);
  const definition = await definitions.setAvailability(admin.userId, id, availability);
  return adminJson('PUT /api/admin/definitions/[id]/availability', { definition });
});

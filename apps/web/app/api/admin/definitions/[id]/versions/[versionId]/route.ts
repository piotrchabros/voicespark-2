import { z } from 'zod';
import * as definitions from '@voicespark/core/services/definitions';
import { handle, parseJson } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

type Ctx = { params: Promise<{ id: string; versionId: string }> };

const patchSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  analysisPrompt: z.string().nullable().optional(),
  // Rejected by the service with `details.field = 'dimensions'`.
  dimensions: z.unknown().optional(),
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id, versionId } = await ctx.params;
  const input = await parseJson(req, patchSchema);
  const version = await definitions.updateDraft(admin.userId, id, versionId, input);
  return adminJson('PATCH /api/admin/definitions/[id]/versions/[versionId]', { version });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const admin = await requireAdmin();
  const { id, versionId } = await ctx.params;
  await definitions.discardDraft(admin.userId, id, versionId);
});

import { z } from 'zod';
import * as prompts from '@voicespark/core/services/prompts';
import { adminJson } from '../../../../../../lib/admin-schemas';
import { requireAdmin } from '../../../../../../lib/guards';
import { handle, parseJson } from '../../../../../../lib/http';

const rollbackBody = z.strictObject({ versionId: z.uuid() });

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const { versionId } = await parseJson(req, rollbackBody);
  const prompt = await prompts.rollback(admin.userId, id, versionId);
  return adminJson('POST /api/admin/prompts/[id]/rollback', { prompt });
});

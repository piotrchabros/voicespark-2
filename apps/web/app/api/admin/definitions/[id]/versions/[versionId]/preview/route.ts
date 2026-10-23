import { z } from 'zod';
import * as definitions from '@voicespark/core/services/definitions';
import * as prompts from '@voicespark/core/services/prompts';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

type Ctx = { params: Promise<{ id: string; versionId: string }> };

const bodySchema = z.strictObject({ kind: z.enum(['generate', 'feedback']).optional() });

// Render only (FR-004): the active wrapper, this version's analysis prompt and the static fixture.
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const admin = await requireAdmin();
  await rateLimit(`admin-preview:${admin.userId}`, 60, 60);
  const { id, versionId } = await ctx.params;
  // The body is optional: an empty body means `kind = generate`.
  const raw = await req.clone().text();
  const { kind } = raw.trim() === '' ? {} : await parseJson(req, bodySchema);
  await definitions.adminGetVersion(id, versionId);
  return adminJson(
    'POST /api/admin/definitions/[id]/versions/[versionId]/preview',
    await prompts.previewDefinitionVersion(versionId, kind),
  );
});

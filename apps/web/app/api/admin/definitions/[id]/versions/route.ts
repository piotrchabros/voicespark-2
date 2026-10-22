import { z } from 'zod';
import * as definitions from '@voicespark/core/services/definitions';
import { handle } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

const bodySchema = z.object({ fromVersionId: z.uuid().optional() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  // The body is optional: an empty or non-JSON body means "draft from the active version".
  const raw: unknown = await req.json().catch(() => ({}));
  const { fromVersionId } = bodySchema.parse(raw ?? {});
  const version = await definitions.createDraft(admin.userId, id, fromVersionId);
  return adminJson('POST /api/admin/definitions/[id]/versions', { version }, 201);
});

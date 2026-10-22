import { z } from 'zod';
import * as adminUsers from '@voicespark/core/services/admin-users';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { AppError, handle, parseJson } from '@/lib/http';

// The reason is accepted but never persisted (D-A6, FR-048).
const bodySchema = z.object({ reason: z.string().max(500).optional() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  // The body is optional: an empty body means no reason.
  const raw = await req.text();
  const body: z.infer<typeof bodySchema> =
    raw.trim() === ''
      ? {}
      : await parseJson(new Request(req.url, { method: 'POST', body: raw }), bodySchema);
  if (!z.uuid().safeParse(id).success) throw new AppError('not_found');
  const user = await adminUsers.suspend(admin.userId, id, body.reason);
  return adminJson('POST /api/admin/users/[id]/suspend', { user });
});

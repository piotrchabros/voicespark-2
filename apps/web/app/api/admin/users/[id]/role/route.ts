import { z } from 'zod';
import { USER_ROLES } from '@voicespark/db';
import * as adminUsers from '@voicespark/core/services/admin-users';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { AppError, handle, parseJson } from '@/lib/http';

const bodySchema = z.object({ role: z.enum(USER_ROLES) });

export const PUT = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  const { role } = await parseJson(req, bodySchema);
  if (!z.uuid().safeParse(id).success) throw new AppError('not_found');
  const user = await adminUsers.setRole(admin.userId, id, role);
  return adminJson('PUT /api/admin/users/[id]/role', { user });
});

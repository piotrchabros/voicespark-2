import { z } from 'zod';
import * as adminUsers from '@voicespark/core/services/admin-users';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { AppError, handle } from '@/lib/http';

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) throw new AppError('not_found');
  const user = await adminUsers.reinstate(admin.userId, id);
  return adminJson('POST /api/admin/users/[id]/reinstate', { user });
});

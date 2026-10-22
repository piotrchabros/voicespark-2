import { z } from 'zod';
import * as adminUsers from '@voicespark/core/services/admin-users';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { AppError, handle } from '@/lib/http';

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdmin();
  const { id } = await ctx.params;
  // User ids are uuids; anything else cannot exist.
  if (!z.uuid().safeParse(id).success) throw new AppError('not_found');
  return adminJson('GET /api/admin/users/[id]', await adminUsers.detail(id));
});

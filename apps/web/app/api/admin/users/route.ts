import { z } from 'zod';
import { USER_ROLES, USER_STATUS } from '@voicespark/db';
import * as adminUsers from '@voicespark/core/services/admin-users';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { handle, parsePagination } from '@/lib/http';

const filterSchema = z.object({
  query: z.string().max(200).optional(),
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUS).optional(),
});

export const GET = handle(async (req: Request) => {
  await requireAdmin();
  const url = new URL(req.url);
  const { cursor, limit } = parsePagination(url);
  const params = url.searchParams;
  const filters = filterSchema.parse({
    query: params.get('query') || undefined,
    role: params.get('role') || undefined,
    status: params.get('status') || undefined,
  });
  const result = await adminUsers.list({
    limit,
    ...(cursor ? { cursor } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  });
  return adminJson('GET /api/admin/users', result);
});

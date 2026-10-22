import { z } from 'zod';
import * as adminSystem from '@voicespark/core/services/admin-system';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { handle, parsePagination } from '@/lib/http';

const querySchema = z.object({
  action: z.string().min(1).optional(),
  actorUserId: z.uuid().optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const GET = handle(async (req) => {
  await requireAdmin();
  const url = new URL(req.url);
  const raw = Object.fromEntries(
    [...url.searchParams.entries()].filter(([k, v]) => k in querySchema.shape && v !== ''),
  );
  const q = querySchema.parse(raw);
  const { cursor, limit } = parsePagination(url);
  const page = await adminSystem.auditQuery({
    ...(q.action ? { action: q.action } : {}),
    ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
    ...(q.targetType ? { targetType: q.targetType } : {}),
    ...(q.targetId ? { targetId: q.targetId } : {}),
    ...(q.from ? { from: new Date(q.from) } : {}),
    ...(q.to ? { to: new Date(q.to) } : {}),
    ...(cursor ? { cursor } : {}),
    limit,
  });
  return adminJson('GET /api/admin/audit', page);
});

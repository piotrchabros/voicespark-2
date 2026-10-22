import { z } from 'zod';
import * as adminSystem from '@voicespark/core/services/admin-system';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { handle } from '@/lib/http';

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const GET = handle(async (req) => {
  await requireAdmin();
  const params = new URL(req.url).searchParams;
  const q = rangeSchema.parse({
    from: params.get('from') || undefined,
    to: params.get('to') || undefined,
  });
  const metrics = await adminSystem.ratingsMetrics({
    ...(q.from ? { from: new Date(q.from) } : {}),
    ...(q.to ? { to: new Date(q.to) } : {}),
  });
  return adminJson('GET /api/admin/metrics/ratings', metrics);
});

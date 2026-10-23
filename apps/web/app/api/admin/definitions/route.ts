import { z } from 'zod';
import * as definitions from '@voicespark/core/services/definitions';
import { handle, parseJson } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

const createSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  analysisPrompt: z.string().nullable().optional(),
  // Rejected by the service with `details.field = 'dimensions'`.
  dimensions: z.unknown().optional(),
});

export const GET = handle(async () => {
  await requireAdmin();
  return adminJson('GET /api/admin/definitions', await definitions.adminList());
});

export const POST = handle(async (req: Request) => {
  const admin = await requireAdmin();
  const input = await parseJson(req, createSchema);
  return adminJson(
    'POST /api/admin/definitions',
    await definitions.create(admin.userId, input),
    201,
  );
});

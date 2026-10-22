import * as adminSystem from '@voicespark/core/services/admin-system';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { handle } from '@/lib/http';

export const GET = handle(async () => {
  await requireAdmin();
  return adminJson('GET /api/admin/system/health', await adminSystem.health());
});

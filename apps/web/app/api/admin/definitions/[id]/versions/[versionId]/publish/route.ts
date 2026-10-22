import * as definitions from '@voicespark/core/services/definitions';
import { handle } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

export const POST = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    const admin = await requireAdmin();
    const { id, versionId } = await ctx.params;
    const definition = await definitions.publish(admin.userId, id, versionId);
    return adminJson('POST /api/admin/definitions/[id]/versions/[versionId]/publish', {
      definition,
    });
  },
);

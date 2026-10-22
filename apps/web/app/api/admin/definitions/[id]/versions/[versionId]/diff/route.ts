import { z } from 'zod';
import * as definitions from '@voicespark/core/services/definitions';
import { handle } from '@/lib/http';
import { requireAdmin } from '@/lib/guards';
import { adminJson } from '@/lib/admin-schemas';

const querySchema = z.object({ against: z.uuid() });

export const GET = handle(
  async (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    await requireAdmin();
    const { id, versionId } = await ctx.params;
    const { against } = querySchema.parse({
      against: new URL(req.url).searchParams.get('against') ?? undefined,
    });
    return adminJson(
      'GET /api/admin/definitions/[id]/versions/[versionId]/diff',
      await definitions.diff(id, versionId, against),
    );
  },
);

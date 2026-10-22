import { z } from 'zod';
import * as profiles from '@voicespark/core/services/profiles';
import { PROFILE_RATINGS } from '@voicespark/db';
import { AppError, handle, parseJson } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

const bodySchema = z.object({ rating: z.enum(PROFILE_RATINGS) });

export const PUT = handle(
  async (req, ctx: { params: Promise<{ id: string; versionId: string }> }) => {
    const user = await requireUser();
    const { id, versionId } = await ctx.params;
    const { rating } = await parseJson(req, bodySchema);
    try {
      return await profiles.rate(user, id, versionId, rating);
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found')
        await auditForeignAccess(user, 'profile', id);
      throw err;
    }
  },
);

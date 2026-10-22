import { z } from 'zod';
import * as profiles from '@voicespark/core/services/profiles';
import { AppError, handle, parseJson } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

const bodySchema = z.object({
  dimensions: z.record(z.string(), z.union([z.number(), z.string(), z.array(z.string())])),
  note: z.string().max(profiles.NOTE_MAX_CHARS).optional(),
});

// `sensitive_content` (422) is thrown by the service and mapped by `handle`.
export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = await parseJson(req, bodySchema);
  try {
    return Response.json(await profiles.adjust(user, id, body), { status: 201 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'profile', id);
    throw err;
  }
});

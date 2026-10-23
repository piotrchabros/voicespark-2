import { z } from 'zod';
import * as profiles from '@voicespark/core/services/profiles';
import { AppError, handle, parseJson } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

// Type-only: limits, `conflict` and `sensitive_content` come from the service so
// `details.field` / `details.fields` match the contract.
const bodySchema = z.object({
  baseVersionId: z.uuid(),
  summary: z.string(),
  sections: z.array(z.object({ heading: z.string(), markdown: z.string() })),
  doList: z.array(z.string()),
  dontList: z.array(z.string()),
  keepExcerpts: z.array(z.number().int()),
});

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const body = await parseJson(req, bodySchema);
  try {
    return Response.json(await profiles.editDocument(user, id, body), { status: 201 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'profile', id);
    throw err;
  }
});

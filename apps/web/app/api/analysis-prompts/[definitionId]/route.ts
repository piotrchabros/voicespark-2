import { z } from 'zod';
import * as ownPrompts from '@voicespark/core/services/own-prompts';
import { handle, parseJson } from '@/lib/http';
import { requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ definitionId: string }> };

// Type-only: the service throws `validation_failed` with `details.field` for empty/too long text.
const bodySchema = z.object({ promptText: z.string(), baseVersionId: z.uuid() });

export const GET = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { definitionId } = await ctx.params;
  return await ownPrompts.get(user, definitionId);
});

export const PUT = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const { definitionId } = await ctx.params;
  const body = await parseJson(req, bodySchema);
  return Response.json(await ownPrompts.save(user, definitionId, body), { status: 201 });
});

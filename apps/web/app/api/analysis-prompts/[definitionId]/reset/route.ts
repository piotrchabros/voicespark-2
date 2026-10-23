import * as ownPrompts from '@voicespark/core/services/own-prompts';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

export const POST = handle(async (_req, ctx: { params: Promise<{ definitionId: string }> }) => {
  const user = await requireUser();
  const { definitionId } = await ctx.params;
  return await ownPrompts.reset(user, definitionId);
});

import * as ownPrompts from '@voicespark/core/services/own-prompts';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

export const GET = handle(async (_req, ctx: { params: Promise<{ definitionId: string }> }) => {
  const user = await requireUser();
  const { definitionId } = await ctx.params;
  return await ownPrompts.compare(user, definitionId);
});

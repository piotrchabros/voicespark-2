import * as ownPrompts from '@voicespark/core/services/own-prompts';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// A missing `from` is rejected by the service (422 `validation_failed`).
export const GET = handle(async (req, ctx: { params: Promise<{ definitionId: string }> }) => {
  const user = await requireUser();
  const { definitionId } = await ctx.params;
  const { searchParams } = new URL(req.url);
  return await ownPrompts.defaultChanges(
    user,
    definitionId,
    searchParams.get('from') ?? undefined,
    searchParams.get('to') ?? undefined,
  );
});

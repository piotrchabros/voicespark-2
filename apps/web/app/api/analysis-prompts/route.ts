import * as ownPrompts from '@voicespark/core/services/own-prompts';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

export const GET = handle(async () => {
  const user = await requireUser();
  return await ownPrompts.list(user);
});

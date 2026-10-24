import { z } from 'zod';
import * as suggestions from '@voicespark/core/services/hub/suggestions';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Accept or reject up to 200 suggestions with per-id results (contracts/http-api.md "Suggestions"; FR-023).
// Another user's id comes back as a per-id `not_found`, never as their data.
const decideSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(suggestions.DECIDE_MAX_IDS),
    action: z.enum(['accept', 'reject']),
  })
  .strict();

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await rateLimit(`hub-suggestions-decide:${user.userId}`, 60, 60);
  const body = await parseJson(req, decideSchema);
  return suggestions.decide(user, body);
});

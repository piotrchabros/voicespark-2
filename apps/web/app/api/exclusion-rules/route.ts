import { z } from 'zod';
import { EXCLUSION_RULE_TYPES } from '@voicespark/db';
import * as exclusionRules from '@voicespark/core/services/exclusion-rules';
import { handle, parseJson } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// The value is normalized and validated per type by the service.
const bodySchema = z.object({ type: z.enum(EXCLUSION_RULE_TYPES), value: z.string().max(1000) });

export const GET = handle(async () => {
  const user = await requireUser();
  return exclusionRules.list(user);
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const input = await parseJson(req, bodySchema);
  return Response.json(await exclusionRules.create(user, input), { status: 201 });
});

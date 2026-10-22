import { z } from 'zod';
import * as profiles from '@voicespark/core/services/profiles';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

const bodySchema = z.object({ definitionIds: z.array(z.uuid()).min(1).max(100).optional() });

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await rateLimit('profile-gen:' + user.userId, 10, 3600);
  // An empty body means "all chosen definitions".
  const raw = await req.clone().text();
  const { definitionIds } = raw.trim() === '' ? {} : await parseJson(req, bodySchema);
  const result = await profiles.generate(user, definitionIds);
  return Response.json(result, { status: 202 });
});

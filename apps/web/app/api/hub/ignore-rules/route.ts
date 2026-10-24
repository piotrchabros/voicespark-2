import { z } from 'zod';
import * as ignoreRules from '@voicespark/core/services/hub/ignore-rules';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Kind and value (address or domain, normalised) are checked by the service (FR-021).
const createSchema = z.record(z.string(), z.unknown());

export const GET = handle(async () => {
  const user = await requireUser();
  return { items: await ignoreRules.list(user) };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await rateLimit(`hub-ignore-rules:${user.userId}`, 60, 60);
  const body = await parseJson(req, createSchema);
  return Response.json({ rule: await ignoreRules.create(user, body) }, { status: 201 });
});

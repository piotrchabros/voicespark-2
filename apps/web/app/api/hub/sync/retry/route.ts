import { z } from 'zod';
import * as sync from '@voicespark/core/services/hub/sync';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Without ids every `failed` row of the user is retried (contracts/http-api.md "Sync"; FR-026).
const retrySchema = z.strictObject({ ids: z.array(z.uuid()).max(500).optional() });

export const POST = handle(async (req) => {
  const user = await requireUser();
  await rateLimit(`hub-sync:${user.userId}`, 30, 60);
  // The body is optional: an empty request retries every failed row.
  const { ids } =
    req.headers.get('content-length') === '0' || req.body === null
      ? { ids: undefined }
      : await parseJson(req, retrySchema);
  return Response.json({ requeued: await sync.retry(user, ids) }, { status: 202 });
});

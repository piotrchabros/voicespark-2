import * as sync from '@voicespark/core/services/hub/sync';
import { handle, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Back-fills missing rows and marks every non-deleted row dirty; never deletes the namespace. The service audits
// `hub.resync_requested {items}` (contracts/http-api.md "Sync"; FR-025, FR-026).
export const POST = handle(async () => {
  const user = await requireUser();
  await rateLimit(`hub-sync:${user.userId}`, 30, 60);
  return Response.json({ requeued: await sync.resync(user) }, { status: 202 });
});

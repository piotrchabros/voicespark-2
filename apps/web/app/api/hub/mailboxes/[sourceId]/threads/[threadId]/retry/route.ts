import { AppError } from '@voicespark/core/errors';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import { handle, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ sourceId: string; threadId: string }> };

// A `failed` thread goes back to `pending` and `hub.thread` is enqueued; 409 `conflict` otherwise.
export const POST = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { sourceId, threadId } = await ctx.params;
  await rateLimit(`hub-mailboxes:${user.userId}`, 30, 60);
  try {
    await mailboxes.retryThread(user, sourceId, threadId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      await auditForeignAccess(user, 'source', sourceId);
      await auditForeignAccess(user, 'hub_thread', threadId);
    }
    throw err;
  }
  return new Response(null, { status: 202 });
});

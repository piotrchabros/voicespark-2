import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ sourceId: string }> };

// `acknowledgeAi: true` is checked by the service (422 otherwise; FR-012).
const enableSchema = z.record(z.string(), z.unknown());

export const POST = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const { sourceId } = await ctx.params;
  await rateLimit(`hub-mailboxes:${user.userId}`, 30, 60);
  const body = await parseJson(req, enableSchema);
  try {
    return { mailbox: await mailboxes.enable(user, sourceId, body) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'source', sourceId);
    throw err;
  }
});

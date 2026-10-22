import * as notifications from '@voicespark/core/services/notifications';
import { AppError, handle } from '../../../../../lib/http';
import { auditForeignAccess, requireUser } from '../../../../../lib/guards';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = handle(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  if (!(await notifications.markRead(user.userId, id))) {
    await auditForeignAccess(user, 'notification', id);
    throw new AppError('not_found');
  }
  return undefined;
});

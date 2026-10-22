import * as notifications from '@voicespark/core/services/notifications';
import { handle, parsePagination } from '../../../lib/http';
import { requireUser } from '../../../lib/guards';

export const GET = handle(async (req) => {
  const user = await requireUser();
  const { items, nextCursor } = await notifications.list(user.userId, parsePagination(req.url));
  return {
    items: items.map((n) => ({
      id: n.id,
      type: n.type,
      payload: n.payload,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    })),
    nextCursor,
  };
});

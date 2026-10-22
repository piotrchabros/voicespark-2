import * as contentItems from '@voicespark/core/services/content-items';
import { requireUser } from '../../../lib/guards';
import { handle, parsePagination } from '../../../lib/http';

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const { cursor, limit } = parsePagination(url);
  const sourceId = url.searchParams.get('sourceId');
  const query = url.searchParams.get('query');
  return contentItems.list(user, {
    limit,
    ...(cursor ? { cursor } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(query ? { query } : {}),
  });
});

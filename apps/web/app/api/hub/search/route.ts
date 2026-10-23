import { z } from 'zod';
import * as search from '@voicespark/core/services/hub/search';
import { handle, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Keyword search over the user's own hub (contracts/http-api.md "Search"; FR-011). Own items only, admins included;
// the response carries highlight offsets, never HTML.
const SEARCH_TYPES = ['person', 'company', 'project', 'note', 'file'] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const querySchema = z.object({
  q: z.string().min(1).max(200),
  types: z.array(z.enum(SEARCH_TYPES)).min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .transform((n) => Math.min(n, MAX_LIMIT))
    .default(DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export const GET = handle(async (req) => {
  const user = await requireUser();
  await rateLimit(`hub-search:${user.userId}`, 60, 60);
  const params = new URL(req.url).searchParams;
  const types = params.get('types');
  const query = querySchema.parse({
    q: params.get('q') ?? '',
    types: types === null ? undefined : types.split(',').map((t) => t.trim()),
    limit: params.get('limit') || undefined,
    cursor: params.get('cursor') || undefined,
  });
  return search.search(user, {
    q: query.q,
    limit: query.limit,
    ...(query.types ? { types: query.types } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
});

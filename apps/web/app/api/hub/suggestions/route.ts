import { z } from 'zod';
import * as suggestions from '@voicespark/core/services/hub/suggestions';
import { handle } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// The suggestion queue (contracts/http-api.md "Suggestions"; FR-023). Own suggestions only, admins included.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const querySchema = z.object({
  state: z.literal('suggested').default('suggested'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
});

export const GET = handle(async (req) => {
  const user = await requireUser();
  const params = new URL(req.url).searchParams;
  const query = querySchema.parse({
    state: params.get('state') || undefined,
    limit: params.get('limit') || undefined,
    cursor: params.get('cursor') || undefined,
  });
  return suggestions.list(user, {
    state: query.state,
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
});

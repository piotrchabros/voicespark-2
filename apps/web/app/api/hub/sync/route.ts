import { z } from 'zod';
import * as sync from '@voicespark/core/services/hub/sync';
import { handle, parsePagination } from '@/lib/http';
import { requireUser } from '@/lib/guards';

// Sync status of the user's hub items (contracts/http-api.md "Sync"; FR-026). Own items only, admins included.
const querySchema = z.object({ status: z.enum(['pending', 'stored', 'failed']).optional() });

export const GET = handle(async (req) => {
  const user = await requireUser();
  const query = querySchema.parse({
    status: new URL(req.url).searchParams.get('status') ?? undefined,
  });
  return sync.status(user, { ...query, ...parsePagination(req.url) });
});

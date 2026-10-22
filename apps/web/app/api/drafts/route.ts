import { z } from 'zod';
import { DRAFT_CONTENT_TYPES } from '@voicespark/db';
import * as drafts from '@voicespark/core/services/drafts';
import { handle, parseJson, parsePagination, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

const querySchema = z.object({
  contentType: z.enum(DRAFT_CONTENT_TYPES).optional(),
  profileId: z.uuid().optional(),
});

const bodySchema = z.object({
  contentType: z.enum(DRAFT_CONTENT_TYPES),
  profileId: z.uuid(),
  brief: z.string().trim().min(1).max(drafts.BRIEF_MAX),
});

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const filters = querySchema.parse({
    contentType: url.searchParams.get('contentType') || undefined,
    profileId: url.searchParams.get('profileId') || undefined,
  });
  return drafts.list(user, { ...filters, ...parsePagination(url) });
});

// Create and regenerate share one per-user limit (D-D7).
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await rateLimit(`drafts:${user.userId}`, 20, 60);
  const input = await parseJson(req, bodySchema);
  return Response.json(await drafts.create(user, input), { status: 202 });
});

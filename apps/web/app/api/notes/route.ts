import { z } from 'zod';
import { AUTHORSHIPS } from '@voicespark/db';
import * as uploads from '@voicespark/core/services/uploads';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { requireFiltersConfirmed, requireUser } from '@/lib/guards';

const bodySchema = z.object({
  text: z.string().min(1).max(uploads.NOTE_MAX_CHARS),
  title: z.string().max(uploads.NOTE_TITLE_MAX).optional(),
  authorship: z.enum(AUTHORSHIPS).optional(),
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await requireFiltersConfirmed(user);
  await rateLimit(`uploads:${user.userId}`, 60, 3600);
  const input = await parseJson(req, bodySchema);
  return Response.json(await uploads.createNote(user, input), { status: 202 });
});

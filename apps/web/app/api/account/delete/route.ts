import * as deletion from '@voicespark/core/services/deletion';
import { z } from 'zod';
import { requireUser } from '@/lib/guards';
import { handle, parseJson } from '@/lib/http';
import { expireSessionCookies } from '@/lib/session-cookies';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ confirm: z.literal('DELETE') });

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await parseJson(req, bodySchema);
  const { deletionRequestId } = await deletion.requestAccountDeletion(user);
  return expireSessionCookies(Response.json({ deletionRequestId }, { status: 202 }), req);
});

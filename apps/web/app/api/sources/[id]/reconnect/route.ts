import { z } from 'zod';
import * as sources from '@voicespark/core/services/sources';
import { AppError, handle, parseJson } from '../../../../../lib/http';
import { auditForeignAccess, requireUser } from '../../../../../lib/guards';

const bodySchema = z.object({ password: z.string().min(1).max(1024).optional() });

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  // OAuth reconnects send no body; IMAP sends `{password}`.
  const hasBody = (await req.clone().text()).trim() !== '';
  const body = hasBody ? await parseJson(req, bodySchema) : {};
  try {
    return await sources.reconnect(user, id, body);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'source', id);
    throw err;
  }
});

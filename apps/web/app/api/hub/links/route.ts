import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as links from '@voicespark/core/services/hub/links';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

// Kind, id pairing and role length are checked by the service (422 with the field names, 409 `invalid_link`).
const createSchema = z.record(z.string(), z.unknown());

const ENDS = [
  ['personId', 'hub_person'],
  ['companyId', 'hub_company'],
  ['projectId', 'hub_project'],
] as const;

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  await rateLimit(`hub-links:${user.userId}`, 120, 60);
  const body = await parseJson(req, createSchema);
  try {
    return Response.json(await links.create(user, body as links.LinkCreateInput), { status: 201 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') {
      for (const [field, type] of ENDS) {
        const id = body[field];
        if (typeof id === 'string') await auditForeignAccess(user, type, id);
      }
    }
    throw err;
  }
});

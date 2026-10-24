import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as records from '@voicespark/core/services/hub/records';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string }> };

// Length, format and unknown keys are checked by the service.
const emailSchema = z.looseObject({ address: z.string() });

export const POST = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  if (kindFromPath(params.kind) !== 'person') throw new AppError('not_found');
  await rateLimit(`hub-records:${user.userId}`, 120, 60);
  const body = await parseJson(req, emailSchema);
  try {
    return Response.json(await records.addEmail(user, 'person', params.id, body), { status: 201 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_person', params.id);
    throw err;
  }
});

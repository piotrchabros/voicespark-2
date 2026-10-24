import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as records from '@voicespark/core/services/hub/records';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string }> };

// Field limits and unknown keys are checked by the service (strict schemas, 422 with the field names).
const patchSchema = z.record(z.string(), z.unknown());

export const GET = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  const preview = new URL(req.url).searchParams.get('deletePreview') === '1';
  try {
    return preview
      ? await records.deletePreview(user, kind, params.id)
      : await records.get(user, kind, params.id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});

export const PATCH = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  await rateLimit(`hub-records:${user.userId}`, 120, 60);
  const body = await parseJson(req, patchSchema);
  try {
    return await records.patch(user, kind, params.id, body as records.PatchInput[typeof kind]);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  await rateLimit(`hub-records:${user.userId}`, 120, 60);
  try {
    await records.remove(user, kind, params.id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});

import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as files from '@voicespark/core/services/hub/files';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ id: string }> };

// Name (1..255, no `/`, `\` or control chars) and description are checked by the service.
const patchSchema = z.record(z.string(), z.unknown());

export const GET = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await files.get(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_file', id);
    throw err;
  }
});

export const PATCH = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`hub-files:${user.userId}`, 120, 60);
  const body = await parseJson(req, patchSchema);
  try {
    return await files.patch(user, id, body as files.FilePatchInput);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_file', id);
    throw err;
  }
});

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`hub-files:${user.userId}`, 120, 60);
  try {
    await files.remove(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_file', id);
    throw err;
  }
});

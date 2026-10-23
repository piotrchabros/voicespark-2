import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as notes from '@voicespark/core/services/hub/notes';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ id: string }> };

// Title length and the ProseMirror body (schema, allowlist, size) are checked by the service.
const patchSchema = z.record(z.string(), z.unknown());

export const GET = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return { note: await notes.get(user, id) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_note', id);
    throw err;
  }
});

export const PATCH = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`hub-notes:${user.userId}`, 120, 60);
  const body = await parseJson(req, patchSchema);
  try {
    return { note: await notes.patch(user, id, body as notes.NotePatchInput) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_note', id);
    throw err;
  }
});

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`hub-notes:${user.userId}`, 120, 60);
  try {
    await notes.remove(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_note', id);
    throw err;
  }
});

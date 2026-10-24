import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as links from '@voicespark/core/services/hub/links';
import { handle, parseJson, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ id: string }> };

// The role itself (string up to 100 chars or null) is checked by the service.
const patchSchema = z.record(z.string(), z.unknown());

export const PATCH = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`hub-links:${user.userId}`, 120, 60);
  const body = await parseJson(req, patchSchema);
  try {
    return await links.setRole(user, id, body.role as string | null);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_link', id);
    throw err;
  }
});

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  await rateLimit(`hub-links:${user.userId}`, 120, 60);
  try {
    await links.remove(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'hub_link', id);
    throw err;
  }
});

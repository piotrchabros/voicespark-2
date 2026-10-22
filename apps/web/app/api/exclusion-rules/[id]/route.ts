import { z } from 'zod';
import * as exclusionRules from '@voicespark/core/services/exclusion-rules';
import { AppError, handle, parseJson } from '@/lib/http';
import { auditForeignAccess, requireUser, type UserContext } from '@/lib/guards';

const bodySchema = z.object({ value: z.string().max(1000) });

async function auditNotFound(user: UserContext, id: string, err: unknown): Promise<never> {
  if (err instanceof AppError && err.code === 'not_found') await auditForeignAccess(user, 'exclusion_rule', id);
  throw err;
}

export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const input = await parseJson(req, bodySchema);
  try {
    return await exclusionRules.update(user, id, input);
  } catch (err) {
    return auditNotFound(user, id, err);
  }
});

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    await exclusionRules.remove(user, id);
  } catch (err) {
    return auditNotFound(user, id, err);
  }
});

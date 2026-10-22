import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as drafts from '@voicespark/core/services/drafts';
import { handle, parseJson } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ id: string }> };

const editSchema = z.object({ editedText: z.string().min(1).max(drafts.EDITED_TEXT_MAX) });

export const GET = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    return await drafts.get(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'draft', id);
    throw err;
  }
});

export const PATCH = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const { editedText } = await parseJson(req, editSchema);
  try {
    return { draft: await drafts.edit(user, id, editedText) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'draft', id);
    throw err;
  }
});

export const DELETE = handle(async (_req, ctx: Ctx) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  try {
    await drafts.remove(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, 'draft', id);
    throw err;
  }
});

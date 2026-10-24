import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as notes from '@voicespark/core/services/hub/notes';
import { handle, parseJson, parsePagination, rateLimit } from '@/lib/http';
import { auditForeignAccess, requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string; id: string }> };

// Title length and the ProseMirror body (schema, allowlist, size) are checked by the service.
const createSchema = z.record(z.string(), z.unknown());

export const GET = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  const page = parsePagination(req.url);
  try {
    return await notes.list(user, kind, params.id, page);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});

export const POST = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const params = await ctx.params;
  const kind = kindFromPath(params.kind);
  if (!kind) throw new AppError('not_found');
  await rateLimit(`hub-notes:${user.userId}`, 120, 60);
  const body = await parseJson(req, createSchema);
  try {
    const note = await notes.create(user, kind, params.id, body as unknown as notes.NoteInput);
    return Response.json({ note }, { status: 201 });
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found')
      await auditForeignAccess(user, `hub_${kind}`, params.id);
    throw err;
  }
});

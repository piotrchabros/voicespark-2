import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import { kindFromPath } from '@voicespark/core/services/hub/common';
import * as records from '@voicespark/core/services/hub/records';
import { handle, parseJson, parsePagination, rateLimit } from '@/lib/http';
import { requireUser } from '@/lib/guards';

type Ctx = { params: Promise<{ kind: string }> };

const listQuerySchema = z.object({
  sort: z.enum(['name', 'updated']).default('name'),
  order: z.enum(['asc', 'desc']).optional(),
});

// Field limits and unknown keys are checked by the service (strict schemas, 422 with the field names).
const createSchema = z.looseObject({ name: z.string() });

export const GET = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const kind = kindFromPath((await ctx.params).kind);
  if (!kind) throw new AppError('not_found');
  const params = new URL(req.url).searchParams;
  const query = listQuerySchema.parse({
    sort: params.get('sort') ?? undefined,
    order: params.get('order') ?? undefined,
  });
  return records.list(user, kind, { ...query, ...parsePagination(req.url) });
});

export const POST = handle(async (req, ctx: Ctx) => {
  const user = await requireUser();
  const kind = kindFromPath((await ctx.params).kind);
  if (!kind) throw new AppError('not_found');
  await rateLimit(`hub-records:${user.userId}`, 120, 60);
  const body = await parseJson(req, createSchema);
  return Response.json(await records.create(user, kind, body as records.CreateInput[typeof kind]), {
    status: 201,
  });
});

import { z } from 'zod';
import * as sources from '@voicespark/core/services/sources';
import { requireFiltersConfirmed, requireUser } from '../../../../../lib/guards';
import { AppError, handle, parseJson } from '../../../../../lib/http';

export const dynamic = 'force-dynamic';

const providerSchema = z.enum(['gmail', 'microsoft']);
const bodySchema = z.object({
  dateRange: z.object({ from: z.string().nullish(), to: z.string().nullish() }).optional(),
});

export const POST = handle(async (req, ctx: { params: Promise<{ provider: string }> }) => {
  const user = await requireUser();
  const provider = providerSchema.safeParse((await ctx.params).provider);
  if (!provider.success) throw new AppError('not_found');
  await requireFiltersConfirmed(user);
  // An empty body is allowed.
  const raw = await req.text();
  const body = raw.trim() === '' ? {} : await parseJson(new Request(req.url, { method: 'POST', body: raw }), bodySchema);
  return sources.startConnect(user, provider.data, body.dateRange);
});

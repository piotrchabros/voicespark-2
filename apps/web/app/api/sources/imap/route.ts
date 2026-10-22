import { z } from 'zod';
import * as sources from '@voicespark/core/services/sources';
import { requireFiltersConfirmed, requireUser } from '../../../../lib/guards';
import { handle, parseJson, rateLimit } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(993),
  tlsMode: z.enum(['tls', 'starttls']),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  dateRange: z.object({ from: z.string().nullish(), to: z.string().nullish() }).optional(),
});

export const POST = handle(async (req) => {
  const user = await requireUser();
  await rateLimit(`imap-connect:${user.userId}`, 10, 3600);
  await requireFiltersConfirmed(user);
  const body = await parseJson(req, bodySchema);
  // The password is never echoed back.
  const source = await sources.connectImap(user, body);
  return Response.json({ source }, { status: 201 });
});

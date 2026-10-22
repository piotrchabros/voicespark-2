import { headers } from 'next/headers';
import { z } from 'zod';
import { SIGN_IN_PROVIDERS } from '@voicespark/db';
import * as identities from '@voicespark/core/services/identities';
import { getAuth } from '../../../../lib/auth';
import { requireUser } from '../../../../lib/guards';
import { handle, parseJson } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  provider: z.enum(SIGN_IN_PROVIDERS),
  via: z.enum(['confirmed_link', 'manual_link']).default('manual_link'),
});

export const POST = handle(async (req) => {
  const ctx = await requireUser();
  const { provider, via } = await parseJson(req, bodySchema);
  const reqHeaders = await headers();
  let authHeaders: Headers | undefined;
  const result = await identities.startLink(
    ctx,
    provider,
    via,
    async ({ provider: p, callbackURL, errorCallbackURL }) => {
      // returnHeaders keeps Better Auth's signed state cookie (Set-Cookie), which the
      // OAuth callback requires; without forwarding it the callback fails with state_mismatch.
      const { headers: h, response } = await getAuth().api.linkSocialAccount({
        body: { provider: p, callbackURL, errorCallbackURL, disableRedirect: true },
        headers: reqHeaders,
        returnHeaders: true,
      });
      authHeaders = h;
      return { url: response.url };
    },
  );
  const res = Response.json(result);
  for (const cookie of authHeaders?.getSetCookie() ?? []) res.headers.append('set-cookie', cookie);
  return res;
});

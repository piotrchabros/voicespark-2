import { z } from 'zod';
import * as sources from '@voicespark/core/services/sources';
import { AppError } from '@voicespark/core/errors';
import { loadEnv } from '@voicespark/core/env';
import { requireUser } from '../../../../../../lib/guards';

export const dynamic = 'force-dynamic';

const providerSchema = z.enum(['gmail', 'microsoft']);

// Absolute from APP_URL, never the request origin (behind a proxy that is the container's listen port).
function redirectTo(path: string): Response {
  return Response.redirect(`${loadEnv().APP_URL.replace(/\/+$/, '')}${path}`, 303);
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AppError) return redirectTo('/sign-in');
    throw err;
  }
  const provider = providerSchema.safeParse((await ctx.params).provider);
  if (!provider.success) return new Response(null, { status: 404 });

  const params = new URL(req.url).searchParams;
  const error = params.get('error');
  if (error) {
    const cancelled = error === 'access_denied';
    return redirectTo(`/sources/connect?error=${cancelled ? 'oauth_cancelled' : 'oauth_failed'}`);
  }
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return redirectTo('/sources/connect?error=oauth_failed');
  try {
    const { sourceId } = await sources.completeConnect(user, {
      state,
      code,
      provider: provider.data,
    });
    return redirectTo(`/sources/${sourceId}`);
  } catch (err) {
    if (err instanceof AppError) return redirectTo('/sources/connect?error=oauth_failed');
    throw err;
  }
}

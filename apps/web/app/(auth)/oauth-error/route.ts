import { loadEnv } from '@voicespark/core/env';
import { isSignInProvider } from '@voicespark/core/services/identities';

// Better Auth sends failed social sign-ins here (`errorCallbackURL: '/oauth-error?provider=X'`) with `?error=`.
export const dynamic = 'force-dynamic';

const CANCELLED = new Set(['access_denied', 'cancelled', 'user_cancelled_authorize']);

export function GET(req: Request) {
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') ?? '';
  const error = url.searchParams.get('error') ?? '';

  let target: string;
  if (error === 'account_not_linked' && isSignInProvider(provider)) {
    // An account with this email already exists (FR-003).
    target = `/link-account?provider=${provider}`;
  } else if (error === 'account_suspended') {
    // The session hook refused a suspended account (lib/auth.ts).
    target = '/sign-in?error=account_suspended';
  } else if (CANCELLED.has(error)) {
    target = '/sign-in?error=oauth_cancelled';
  } else {
    target = '/sign-in?error=oauth_failed';
  }
  // Absolute from APP_URL, never the request origin (behind a proxy that is the container's listen port).
  return Response.redirect(`${loadEnv().APP_URL.replace(/\/+$/, '')}${target}`, 302);
}

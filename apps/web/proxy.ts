import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

// Optimistic check only (cookie present). Role and status are enforced server-side by
// requireUser()/requireAdmin() in layouts and handlers.
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/sign-in', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/onboarding/:path*',
    '/sources/:path*',
    '/uploads/:path*',
    '/content/:path*',
    '/filters/:path*',
    '/exclusion-rules/:path*',
    '/profiles/:path*',
    '/drafts/:path*',
    '/notifications/:path*',
    '/settings/:path*',
    '/admin/:path*',
  ],
};

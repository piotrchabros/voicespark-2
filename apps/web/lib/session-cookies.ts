// Better Auth session cookies (default prefix); the `__Secure-` variants are used on https.
const COOKIE_NAMES = ['better-auth.session_token', 'better-auth.session_data', 'better-auth.dont_remember'];

/** Appends expiring `Set-Cookie` headers for every session cookie so the browser drops the signed-out session. */
export function expireSessionCookies(res: Response, _req: Request): Response {
  for (const name of COOKIE_NAMES) {
    res.headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.headers.append('Set-Cookie', `__Secure-${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }
  return res;
}

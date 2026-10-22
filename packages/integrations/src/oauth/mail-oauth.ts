import { Google, MicrosoftEntraId, OAuth2RequestError, generateCodeVerifier as arcticCodeVerifier } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import { MailAuthError } from '../mail/errors';
import type { OAuthTokens } from '../mail/types';

// Mailbox OAuth (separate clients from sign-in, FR-005). Least privilege: read-only mail scopes only, PKCE (S256).

export interface MailOAuthEnv {
  APP_URL: string;
  GOOGLE_MAIL_CLIENT_ID: string;
  GOOGLE_MAIL_CLIENT_SECRET: string;
  MICROSOFT_MAIL_CLIENT_ID: string;
  MICROSOFT_MAIL_CLIENT_SECRET: string;
  MICROSOFT_MAIL_TENANT_ID: string;
}

export type MailOAuthProvider = 'gmail' | 'microsoft';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPES: readonly string[] = [GMAIL_READONLY_SCOPE];
export const MICROSOFT_MAIL_SCOPES: readonly string[] = ['Mail.Read', 'offline_access', 'User.Read'];

// Microsoft always reports the OIDC identity scopes alongside the requested ones; they grant no mailbox data.
const MICROSOFT_IDENTITY_SCOPES = ['openid', 'profile', 'email'];
const GRAPH_RESOURCE_PREFIX = 'https://graph.microsoft.com/';

export function mailRedirectUri(env: MailOAuthEnv, p: MailOAuthProvider): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/api/sources/connect/${p}/callback`;
}

export function generateCodeVerifier(): string {
  return arcticCodeVerifier();
}

function google(env: MailOAuthEnv): Google {
  return new Google(env.GOOGLE_MAIL_CLIENT_ID, env.GOOGLE_MAIL_CLIENT_SECRET, mailRedirectUri(env, 'gmail'));
}

function microsoft(env: MailOAuthEnv): MicrosoftEntraId {
  return new MicrosoftEntraId(
    env.MICROSOFT_MAIL_TENANT_ID,
    env.MICROSOFT_MAIL_CLIENT_ID,
    env.MICROSOFT_MAIL_CLIENT_SECRET,
    mailRedirectUri(env, 'microsoft'),
  );
}

export function gmailAuthorizeUrl(env: MailOAuthEnv, state: string, verifier: string): URL {
  const url = google(env).createAuthorizationURL(state, verifier, [...GMAIL_SCOPES]);
  // A refresh token is needed for background sync; prompt=consent makes Google issue it on every connect.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url;
}

export function microsoftAuthorizeUrl(env: MailOAuthEnv, state: string, verifier: string): URL {
  return microsoft(env).createAuthorizationURL(state, verifier, [...MICROSOFT_MAIL_SCOPES]);
}

export function authorizeUrl(env: MailOAuthEnv, p: MailOAuthProvider, state: string, verifier: string): URL {
  return p === 'gmail' ? gmailAuthorizeUrl(env, state, verifier) : microsoftAuthorizeUrl(env, state, verifier);
}

function toTokens(t: OAuth2Tokens, fallbackScopes: readonly string[] = []): OAuthTokens {
  const data = t.data as Record<string, unknown>;
  return {
    accessToken: t.accessToken(),
    refreshToken: t.hasRefreshToken() ? t.refreshToken() : null,
    expiresAt: typeof data.expires_in === 'number' ? t.accessTokenExpiresAt() : null,
    scopes: t.hasScopes() ? t.scopes() : [...fallbackScopes],
  };
}

export async function exchangeCode(
  env: MailOAuthEnv,
  p: MailOAuthProvider,
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const tokens =
    p === 'gmail'
      ? await google(env).validateAuthorizationCode(code, verifier)
      : await microsoft(env).validateAuthorizationCode(code, verifier);
  // No fallback: the granted scopes must be checked with assertMinimalScopes.
  return toTokens(tokens);
}

function normalizeScope(p: MailOAuthProvider, scope: string): string {
  if (p === 'microsoft' && scope.toLowerCase().startsWith(GRAPH_RESOURCE_PREFIX)) {
    return scope.slice(GRAPH_RESOURCE_PREFIX.length);
  }
  return scope;
}

/** Rejects a grant that is missing read access or carries anything beyond the requested read-only scopes. */
export function assertMinimalScopes(p: MailOAuthProvider, granted: readonly string[]): void {
  const allowed = p === 'gmail' ? GMAIL_SCOPES : [...MICROSOFT_MAIL_SCOPES, ...MICROSOFT_IDENTITY_SCOPES];
  const allowedLower = new Set(allowed.map((s) => s.toLowerCase()));
  const normalized = granted.map((s) => normalizeScope(p, s).toLowerCase());
  if (normalized.some((s) => !allowedLower.has(s))) throw new Error('scope_not_minimal');
  const required = p === 'gmail' ? GMAIL_READONLY_SCOPE : 'Mail.Read';
  if (!normalized.includes(required.toLowerCase())) throw new Error('scope_missing');
}

export async function refreshAccessToken(
  env: MailOAuthEnv,
  p: MailOAuthProvider,
  refreshToken: string,
): Promise<OAuthTokens> {
  try {
    const tokens =
      p === 'gmail'
        ? await google(env).refreshAccessToken(refreshToken)
        : await microsoft(env).refreshAccessToken(refreshToken, [...MICROSOFT_MAIL_SCOPES]);
    // A refresh response may omit scope (and refresh_token): keep the minimal set we requested.
    return toTokens(tokens, p === 'gmail' ? GMAIL_SCOPES : MICROSOFT_MAIL_SCOPES);
  } catch (err) {
    if (err instanceof OAuth2RequestError && (err.code === 'invalid_grant' || err.code === 'unauthorized_client')) {
      throw new MailAuthError();
    }
    throw err;
  }
}

export async function revokeGoogleToken(token: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  if (!res.ok) throw new Error(`google_revoke_failed:${res.status}`);
}

export interface ConsentSummary {
  provider: 'gmail' | 'microsoft' | 'imap';
  version: string;
  title: string;
  items: string[];
}

// Shown before connecting; the version is stored as connected_source.consent_text_version (FR-008).
export const CONSENT_SUMMARY: Readonly<Record<'gmail' | 'microsoft' | 'imap', ConsentSummary>> = {
  gmail: {
    provider: 'gmail',
    version: 'gmail-v1',
    title: 'Connect Gmail with read-only access',
    items: [
      'VoiceSpark gets read-only access to your Gmail messages (gmail.readonly). It cannot send, delete, label or change anything.',
      'It reads messages in the date range you choose, excluding Spam, Trash and Drafts, and checks for new mail periodically.',
      'Each message is screened for sensitive content before anything is stored; excluded content is never stored.',
      'You can pause, disconnect or delete imported content at any time, and revoke access from your Google account.',
    ],
  },
  microsoft: {
    provider: 'microsoft',
    version: 'microsoft-v1',
    title: 'Connect Outlook / Microsoft 365 with read-only access',
    items: [
      'VoiceSpark gets read-only access to your mail (Mail.Read) and your basic profile to identify the mailbox (User.Read). It cannot send, delete, move or change anything.',
      'It reads messages in the date range you choose, excluding Deleted Items, Junk Email and Drafts, and checks for new mail periodically.',
      'Each message is screened for sensitive content before anything is stored; excluded content is never stored.',
      'You can pause, disconnect or delete imported content at any time, and revoke access from your Microsoft account.',
    ],
  },
  imap: {
    provider: 'imap',
    version: 'imap-v1',
    title: 'Connect a mailbox over IMAP',
    items: [
      'VoiceSpark opens your folders read-only. It never sends mail, deletes, moves or marks messages as read.',
      'Use an app password where your provider supports one; it is stored encrypted and used only to read mail.',
      'It reads messages in the date range you choose, skipping Trash, Junk and Drafts, and checks for new mail periodically.',
      'Each message is screened for sensitive content before anything is stored; excluded content is never stored.',
      'You can pause, disconnect or delete imported content at any time.',
    ],
  },
};

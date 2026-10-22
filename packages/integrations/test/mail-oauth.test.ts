import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailAuthError, mapLimit } from '../src/mail';
import {
  CONSENT_SUMMARY,
  GMAIL_SCOPES,
  MICROSOFT_MAIL_SCOPES,
  assertMinimalScopes,
  authorizeUrl,
  exchangeCode,
  generateCodeVerifier,
  gmailAuthorizeUrl,
  mailRedirectUri,
  microsoftAuthorizeUrl,
  refreshAccessToken,
  revokeGoogleToken,
  type MailOAuthEnv,
} from '../src/oauth';

const env: MailOAuthEnv = {
  APP_URL: 'https://app.example.test',
  GOOGLE_MAIL_CLIENT_ID: 'g-client',
  GOOGLE_MAIL_CLIENT_SECRET: 'g-secret',
  MICROSOFT_MAIL_CLIENT_ID: 'm-client',
  MICROSOFT_MAIL_CLIENT_SECRET: 'm-secret',
  MICROSOFT_MAIL_TENANT_ID: 'common',
};

function tokenResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authorize urls', () => {
  it('builds the gmail url with read-only scope, offline access, consent and PKCE', () => {
    const verifier = generateCodeVerifier();
    const url = gmailAuthorizeUrl(env, 'state-1', verifier);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBeTruthy();
    expect(p.get('code_challenge')).not.toBe(verifier);
    expect(p.get('state')).toBe('state-1');
    expect(p.get('client_id')).toBe('g-client');
    expect(p.get('redirect_uri')).toBe('https://app.example.test/api/sources/connect/gmail/callback');
    expect(p.get('include_granted_scopes')).toBeNull();
  });

  it('builds the microsoft url for the tenant with mail read scopes and PKCE', () => {
    const url = microsoftAuthorizeUrl(env, 'state-2', generateCodeVerifier());
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    const p = url.searchParams;
    expect(p.get('scope')).toBe('Mail.Read offline_access User.Read');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('client_id')).toBe('m-client');
    expect(p.get('redirect_uri')).toBe('https://app.example.test/api/sources/connect/microsoft/callback');
  });

  it('dispatches by provider and builds redirect uris', () => {
    expect(authorizeUrl(env, 'gmail', 's', generateCodeVerifier()).hostname).toBe('accounts.google.com');
    expect(authorizeUrl(env, 'microsoft', 's', generateCodeVerifier()).hostname).toBe('login.microsoftonline.com');
    expect(mailRedirectUri({ ...env, APP_URL: 'http://localhost:3000/' }, 'gmail')).toBe(
      'http://localhost:3000/api/sources/connect/gmail/callback',
    );
  });

  it('requests only least-privilege scopes', () => {
    expect(GMAIL_SCOPES).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(MICROSOFT_MAIL_SCOPES).toEqual(['Mail.Read', 'offline_access', 'User.Read']);
  });
});

describe('assertMinimalScopes', () => {
  it('accepts exactly gmail.readonly', () => {
    expect(() => assertMinimalScopes('gmail', ['https://www.googleapis.com/auth/gmail.readonly'])).not.toThrow();
  });

  it('rejects extra or missing gmail scopes', () => {
    expect(() =>
      assertMinimalScopes('gmail', [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ]),
    ).toThrow('scope_not_minimal');
    expect(() => assertMinimalScopes('gmail', ['https://mail.google.com/'])).toThrow('scope_not_minimal');
    expect(() => assertMinimalScopes('gmail', [])).toThrow('scope_missing');
  });

  it('accepts microsoft scopes in short or resource form plus identity scopes', () => {
    expect(() =>
      assertMinimalScopes('microsoft', [
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/User.Read',
        'openid',
        'profile',
        'email',
      ]),
    ).not.toThrow();
    expect(() => assertMinimalScopes('microsoft', ['Mail.Read', 'User.Read', 'offline_access'])).not.toThrow();
  });

  it('rejects broader microsoft scopes and a grant without Mail.Read', () => {
    expect(() => assertMinimalScopes('microsoft', ['Mail.Read', 'Mail.Send'])).toThrow('scope_not_minimal');
    expect(() => assertMinimalScopes('microsoft', ['Mail.ReadWrite'])).toThrow('scope_not_minimal');
    expect(() => assertMinimalScopes('microsoft', ['User.Read'])).toThrow('scope_missing');
  });
});

describe('token exchange and refresh', () => {
  it('maps the code exchange response to OAuthTokens', async () => {
    const fetchMock = vi.fn(async (_req: Request) =>
      tokenResponse({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens = await exchangeCode(env, 'gmail', 'code-1', 'verifier-1');
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(tokens.expiresAt).toBeInstanceOf(Date);
    const body = await (fetchMock.mock.calls[0]![0] as Request).text();
    expect(new URLSearchParams(body).get('code_verifier')).toBe('verifier-1');
  });

  it('keeps the requested scopes when a refresh response omits them', async () => {
    vi.stubGlobal('fetch', async () => tokenResponse({ access_token: 'at2', expires_in: 3600, token_type: 'Bearer' }));
    const tokens = await refreshAccessToken(env, 'gmail', 'rt');
    expect(tokens).toMatchObject({ accessToken: 'at2', refreshToken: null, scopes: [...GMAIL_SCOPES] });
  });

  it('maps invalid_grant on refresh to MailAuthError', async () => {
    vi.stubGlobal('fetch', async () => tokenResponse({ error: 'invalid_grant' }, 400));
    await expect(refreshAccessToken(env, 'gmail', 'rt')).rejects.toBeInstanceOf(MailAuthError);
    await expect(refreshAccessToken(env, 'microsoft', 'rt')).rejects.toBeInstanceOf(MailAuthError);
  });

  it('posts the token to the google revoke endpoint', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('', { status: 200 }));
    await revokeGoogleToken('tok', fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/revoke',
      expect.objectContaining({ method: 'POST', body: 'token=tok' }),
    );
    const failing = vi.fn(async () => new Response('', { status: 503 }));
    await expect(revokeGoogleToken('tok', failing as unknown as typeof fetch)).rejects.toThrow('google_revoke_failed');
  });
});

describe('consent summaries', () => {
  it('has a versioned summary per provider', () => {
    for (const p of ['gmail', 'microsoft', 'imap'] as const) {
      const s = CONSENT_SUMMARY[p];
      expect(s.provider).toBe(p);
      expect(s.version).toMatch(new RegExp(`^${p}-v\\d+$`));
      expect(s.items.length).toBeGreaterThan(0);
      expect(s.items.join(' ')).toMatch(/read-only|readOnly|opens your folders read-only/i);
    }
  });
});

describe('mapLimit', () => {
  it('keeps order and caps concurrency', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return `${i}:${n}`;
    });
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3']);
    expect(max).toBe(2);
    await expect(mapLimit([], 3, async () => 1)).resolves.toEqual([]);
  });
});

import { createHash } from 'node:crypto';
import { loadEnv } from '@voicespark/core/env';

// Mock OAuth server for e2e sign-in (AUTH_TEST_MODE only; never available in production).
// It serves all four test-mode providers; the provider comes from `client_id` (`test-mock-<provider>`).
export const dynamic = 'force-dynamic';

interface MockIdentity {
  email: string;
  name: string;
  provider: string;
}

const CLIENT_ID_PREFIX = 'test-mock-';

const enabled = () => {
  const env = loadEnv();
  return env.AUTH_TEST_MODE && env.NODE_ENV !== 'production';
};

const notFound = () => new Response('Not found', { status: 404 });

const encode = (identity: MockIdentity) => Buffer.from(JSON.stringify(identity)).toString('base64url');

function decode(code: string | null | undefined): MockIdentity | null {
  if (!code) return null;
  try {
    const parsed = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as Partial<MockIdentity>;
    if (
      typeof parsed.email !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.provider !== 'string'
    ) {
      return null;
    }
    return { email: parsed.email, name: parsed.name, provider: parsed.provider };
  } catch {
    return null;
  }
}

async function handle(req: Request, step: string): Promise<Response> {
  if (!enabled()) return notFound();
  const url = new URL(req.url);

  if (step === 'authorize' && req.method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const clientId = url.searchParams.get('client_id');
    if (!redirectUri || !state || !clientId?.startsWith(CLIENT_ID_PREFIX)) {
      return new Response('Bad request', { status: 400 });
    }
    const target = new URL(redirectUri);
    if (url.searchParams.get('cancel') === '1') {
      // The user cancelled at the provider.
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('state', state);
      return Response.redirect(target.toString(), 302);
    }
    const email = url.searchParams.get('login_hint');
    if (!email) return new Response('Bad request', { status: 400 });
    const name = url.searchParams.get('name') ?? email.split('@')[0] ?? 'Test User';
    const provider = clientId.slice(CLIENT_ID_PREFIX.length);
    target.searchParams.set('code', encode({ email, name, provider }));
    target.searchParams.set('state', state);
    return Response.redirect(target.toString(), 302);
  }

  if (step === 'token' && req.method === 'POST') {
    const code = new URLSearchParams(await req.text()).get('code');
    if (!decode(code)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json({ access_token: code, token_type: 'Bearer', expires_in: 3600 });
  }

  if (step === 'userinfo' && req.method === 'GET') {
    const identity = decode(req.headers.get('authorization')?.replace(/^Bearer /i, ''));
    if (!identity) return Response.json({ error: 'invalid_token' }, { status: 401 });
    const sub = createHash('sha256').update(`${identity.provider}:${identity.email}`).digest('hex');
    // Plain-OAuth generic providers key the account on `id`; `sub` is kept for OIDC-shaped clients.
    return Response.json({
      id: sub,
      sub,
      email: identity.email,
      // Facebook never reports a verified email (R3).
      email_verified: identity.provider !== 'facebook',
      name: identity.name,
    });
  }

  return notFound();
}

type Ctx = { params: Promise<{ step: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return handle(req, (await params).step);
}

export async function POST(req: Request, { params }: Ctx) {
  return handle(req, (await params).step);
}

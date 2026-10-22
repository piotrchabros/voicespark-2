import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { and, count, eq, ne } from 'drizzle-orm';
import { account, authSchema, getDb, user, SIGN_IN_PROVIDERS } from '@voicespark/db';
import { loadEnv, type Env } from '@voicespark/core/env';
import { audit } from '@voicespark/core/services/audit';
import * as identities from '@voicespark/core/services/identities';
import { getAppleClientSecret } from './apple-secret';

/** In test mode the mock OAuth server stands in for every sign-in provider under its real id (D-C1). */
export const TEST_MODE_PROVIDERS = SIGN_IN_PROVIDERS;

// Sign-in requests identity scopes only, never mailbox scopes (constitution II, FR-005).
const SIGN_IN_SCOPES = ['openid', 'email', 'profile'];

/** Provider tokens a sign-in never needs again (FR-005); the mailbox uses its own OAuth flow and credentials. */
export const NULLED_PROVIDER_TOKENS = {
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
} as const;

const isTestMode = (env: Env) => env.AUTH_TEST_MODE && env.NODE_ENV !== 'production';

const appleConfigured = (env: Env) =>
  !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);

/** '' when Apple sign-in is off; otherwise the current (memoized, periodically refreshed) client secret. */
function currentAppleSecret(env: Env): string {
  return !isTestMode(env) && appleConfigured(env) ? getAppleClientSecret(env) : '';
}

function createAuth(appleClientSecret: string) {
  const env = loadEnv();
  const db = getDb();
  const testMode = isTestMode(env);

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    advanced: {
      database: {
        generateId: () => randomUUID(),
        // The schema deliberately has no `account.password` column (FR-002), which Better Auth's runtime schema
        // check always expects; it would fail every auth endpoint with SCHEMA_MISMATCH.
        validateSchema: false,
      },
    },
    // No passwords anywhere (FR-002).
    emailAndPassword: { enabled: false },
    // Real providers are registered only outside test mode and only when their credentials are set.
    socialProviders: {
      google: {
        enabled: !testMode && !!(env.GOOGLE_SIGNIN_CLIENT_ID && env.GOOGLE_SIGNIN_CLIENT_SECRET),
        clientId: env.GOOGLE_SIGNIN_CLIENT_ID,
        clientSecret: env.GOOGLE_SIGNIN_CLIENT_SECRET,
        disableDefaultScope: true,
        scope: SIGN_IN_SCOPES,
      },
      apple: {
        enabled: !!appleClientSecret,
        clientId: env.APPLE_CLIENT_ID,
        clientSecret: appleClientSecret,
        // Apple has no `profile` scope; `name email` is its equivalent of openid email profile (openid is implicit).
        disableDefaultScope: true,
        scope: ['name', 'email'],
      },
      microsoft: {
        enabled: !testMode && !!(env.MICROSOFT_SIGNIN_CLIENT_ID && env.MICROSOFT_SIGNIN_CLIENT_SECRET),
        clientId: env.MICROSOFT_SIGNIN_CLIENT_ID,
        clientSecret: env.MICROSOFT_SIGNIN_CLIENT_SECRET,
        tenantId: env.MICROSOFT_SIGNIN_TENANT_ID,
        // Drops the default User.Read and offline_access; without User.Read the Graph photo fetch is skipped too.
        disableDefaultScope: true,
        scope: SIGN_IN_SCOPES,
        disableProfilePhoto: true,
      },
      facebook: {
        enabled: !testMode && !!(env.FACEBOOK_CLIENT_ID && env.FACEBOOK_CLIENT_SECRET),
        clientId: env.FACEBOOK_CLIENT_ID,
        clientSecret: env.FACEBOOK_CLIENT_SECRET,
        // Facebook has no `openid`/`profile` scopes; `email public_profile` is the equivalent set.
        disableDefaultScope: true,
        scope: ['email', 'public_profile'],
      },
    },
    account: {
      // Provider tokens are never used for mailbox access (FR-005). They are nulled right after sign-up and on every
      // update (databaseHooks below); a linked account keeps them only until link completion has read the provider
      // email (app/api/identities/link/complete). Encrypted for that short window.
      encryptOAuthTokens: true,
      // Implicit linking is off, so a same-email sign-in gets `account_not_linked`. Trust only affects explicit
      // `linkSocial`, which must work for Facebook's unverified email (D-C2).
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [...SIGN_IN_PROVIDERS],
        allowDifferentEmails: true,
      },
    },
    session: { cookieCache: { enabled: true, maxAge: 60 } },
    user: {
      additionalFields: {
        role: { type: 'string', required: false, input: false },
        status: { type: 'string', required: false, input: false },
        suspendedAt: { type: 'date', required: false, input: false },
        suspendedBy: { type: 'string', required: false, input: false },
        lastSignInAt: { type: 'date', required: false, input: false },
      },
    },
    databaseHooks: {
      // Better Auth stores the id token in plain text; it is never needed after sign-in, so drop it (D-C3).
      // Access/refresh tokens are dropped too, except on a freshly linked account until link completion (T164).
      account: {
        create: {
          before: async (data) => ({ data: { ...data, idToken: null } }),
          after: async (created) => {
            const [others] = await db
              .select({ n: count() })
              .from(account)
              .where(and(eq(account.userId, created.userId), ne(account.id, created.id)));
            if ((others?.n ?? 0) === 0) {
              await db.update(account).set(NULLED_PROVIDER_TOKENS).where(eq(account.id, created.id));
              const [owner] = await db
                .select({ email: user.email, emailVerified: user.emailVerified })
                .from(user)
                .where(eq(user.id, created.userId))
                .limit(1);
              await identities.recordIdentity({
                accountId: created.id,
                userId: created.userId,
                provider: created.providerId,
                email: owner?.email ?? null,
                emailVerified: owner?.emailVerified ?? false,
                linkedVia: 'signup',
              });
            } else {
              // A linked identity; completeLink fills in its email and verification state.
              await identities.recordIdentity({
                accountId: created.id,
                userId: created.userId,
                provider: created.providerId,
                email: null,
                emailVerified: false,
                linkedVia: 'manual_link',
              });
            }
          },
        },
        update: {
          // Re-sign-in and re-link both arrive here; neither needs the provider tokens afterwards.
          before: async (data) => ({ data: { ...data, idToken: null, ...NULLED_PROVIDER_TOKENS } }),
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [row] = await db
              .select({ status: user.status })
              .from(user)
              .where(eq(user.id, session.userId))
              .limit(1);
            if (row && row.status !== 'active') {
              await audit.record({
                actorType: 'system',
                action: 'auth.sign_in_refused_suspended',
                targetType: 'user',
                targetId: session.userId,
              });
              // An APIError with a code makes the OAuth callback redirect to errorCallbackURL with `?error=<code>`
              // (a plain Error would surface as HTTP 500); /oauth-error maps it to the sign-in page.
              throw new APIError('FORBIDDEN', { code: 'account_suspended', message: 'This account is suspended.' });
            }
            return { data: session };
          },
          after: async (session) => {
            await db.update(user).set({ lastSignInAt: new Date() }).where(eq(user.id, session.userId));
            await audit.record({
              actorType: 'user',
              actorUserId: session.userId,
              action: 'auth.sign_in',
            });
          },
        },
      },
    },
    plugins: testMode
      ? [
          genericOAuth({
            config: TEST_MODE_PROVIDERS.map((providerId) => ({
              providerId,
              clientId: `test-mock-${providerId}`,
              clientSecret: 'test-mock-secret',
              authorizationUrl: `${env.APP_URL}/api/test-oauth/authorize`,
              tokenUrl: `${env.APP_URL}/api/test-oauth/token`,
              userInfoUrl: `${env.APP_URL}/api/test-oauth/userinfo`,
              scopes: SIGN_IN_SCOPES,
            })),
          }),
        ]
      : [],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: { auth: Auth; appleSecret: string } | undefined;

/** Rebuilds the instance when the Apple client secret was regenerated. */
export function getAuth(): Auth {
  const appleSecret = currentAppleSecret(loadEnv());
  if (!cached || cached.appleSecret !== appleSecret) cached = { auth: createAuth(appleSecret), appleSecret };
  return cached.auth;
}

export type Session = Auth['$Infer']['Session'];

import { eq } from 'drizzle-orm';
import { connectedSource, getDb, mailboxCredential, type DbOrTx, type MailboxCredential } from '@voicespark/db';
import { createGmailClient, createGmailFetcher } from '@voicespark/integrations/gmail';
import {
  createImapFetcher,
  verifyConnection,
  type ImapConfig,
  type ImapConnectOptions,
} from '@voicespark/integrations/imap';
import {
  ImapConnectError,
  MailAuthError,
  type MailFetcher,
  type OAuthTokens,
  type TokenProvider,
} from '@voicespark/integrations/mail';
import { createGraphClient, createGraphFetcher } from '@voicespark/integrations/microsoft';
import { refreshAccessToken, type MailOAuthEnv, type MailOAuthProvider } from '@voicespark/integrations/oauth';
import { decrypt, encrypt, getKeyring } from '../crypto';
import { loadEnv } from '../env';
import { AppError } from '../errors';

// Mailbox access for the sources service and the import worker. Tokens and IMAP passwords are only ever stored
// encrypted under the `mailbox-credentials` purpose (constitution VII) and never leave this module decrypted
// except into the provider clients.

/** Access tokens expiring within this window are refreshed before use. */
export const TOKEN_REFRESH_MARGIN_MS = 120_000;

let imapOptions: ImapConnectOptions | undefined;

/** Test-only hook (GreenMail's self-signed certificate, D-C20); production keeps TLS verification on. */
export function configureMailAccess(c: { imap?: ImapConnectOptions }): void {
  if (c.imap) imapOptions = { ...c.imap };
}

/**
 * Defaults read lazily on first use: TEST_IMAP_INSECURE_TLS turns certificate verification off only under
 * NODE_ENV=test / AUTH_TEST_MODE (e2e against GreenMail, D-M1); production refuses the flag at startup and is
 * re-checked here. `configureMailAccess` overrides.
 */
function getImapOptions(): ImapConnectOptions {
  if (!imapOptions) {
    const env = loadEnv();
    const insecure =
      env.TEST_IMAP_INSECURE_TLS && (env.AUTH_TEST_MODE || env.NODE_ENV === 'test') && env.NODE_ENV !== 'production';
    imapOptions = insecure ? { rejectUnauthorized: false } : {};
  }
  return imapOptions;
}

export function mailOAuthEnv(): MailOAuthEnv {
  const env = loadEnv();
  return {
    APP_URL: env.APP_URL,
    GOOGLE_MAIL_CLIENT_ID: env.GOOGLE_MAIL_CLIENT_ID,
    GOOGLE_MAIL_CLIENT_SECRET: env.GOOGLE_MAIL_CLIENT_SECRET,
    MICROSOFT_MAIL_CLIENT_ID: env.MICROSOFT_MAIL_CLIENT_ID,
    MICROSOFT_MAIL_CLIENT_SECRET: env.MICROSOFT_MAIL_CLIENT_SECRET,
    MICROSOFT_MAIL_TENANT_ID: env.MICROSOFT_MAIL_TENANT_ID,
  };
}

/** Synchronous connect + login check; maps the integration error to `imap_auth_failed` / `imap_connection_failed`. */
export async function verifyImap(cfg: ImapConfig): Promise<void> {
  try {
    await verifyConnection(cfg, getImapOptions());
  } catch (err) {
    if (err instanceof ImapConnectError) throw new AppError(err.code);
    throw err;
  }
}

const seal = (value: string) => encrypt('mailbox-credentials', value);
const open = (value: string) => decrypt('mailbox-credentials', value);

/**
 * Upserts the OAuth credential. A token response without a refresh token (common on refresh) keeps the stored
 * one, re-encrypted under the active key so `key_id` stays accurate.
 */
export async function saveOAuthCredential(db: DbOrTx, sourceId: string, tokens: OAuthTokens): Promise<void> {
  let refreshToken = tokens.refreshToken;
  if (refreshToken === null) {
    const [existing] = await db
      .select({ refreshTokenEnc: mailboxCredential.refreshTokenEnc })
      .from(mailboxCredential)
      .where(eq(mailboxCredential.sourceId, sourceId))
      .limit(1);
    refreshToken = existing?.refreshTokenEnc ? open(existing.refreshTokenEnc) : null;
  }
  const values = {
    kind: 'oauth' as const,
    accessTokenEnc: seal(tokens.accessToken),
    refreshTokenEnc: refreshToken === null ? null : seal(refreshToken),
    tokenExpiresAt: tokens.expiresAt,
    grantedScopes: [...tokens.scopes],
    imapHost: null,
    imapPort: null,
    imapTlsMode: null,
    imapUsername: null,
    imapPasswordEnc: null,
    keyId: getKeyring().activeKeyId,
    updatedAt: new Date(),
  };
  await db
    .insert(mailboxCredential)
    .values({ sourceId, ...values })
    .onConflictDoUpdate({ target: mailboxCredential.sourceId, set: values });
}

export async function saveImapCredential(db: DbOrTx, sourceId: string, cfg: ImapConfig): Promise<void> {
  const values = {
    kind: 'imap_password' as const,
    accessTokenEnc: null,
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    grantedScopes: [],
    imapHost: cfg.host,
    imapPort: cfg.port,
    imapTlsMode: cfg.tlsMode,
    imapUsername: cfg.username,
    imapPasswordEnc: seal(cfg.password),
    keyId: getKeyring().activeKeyId,
    updatedAt: new Date(),
  };
  await db
    .insert(mailboxCredential)
    .values({ sourceId, ...values })
    .onConflictDoUpdate({ target: mailboxCredential.sourceId, set: values });
}

/** Stored IMAP settings without the password (reconnect re-verifies with a new one). */
export async function loadImapSettings(
  sourceId: string,
  db: DbOrTx = getDb(),
): Promise<Omit<ImapConfig, 'password'> | null> {
  const [cred] = await db.select().from(mailboxCredential).where(eq(mailboxCredential.sourceId, sourceId)).limit(1);
  return cred ? imapSettingsOf(cred) : null;
}

function imapSettingsOf(cred: MailboxCredential): Omit<ImapConfig, 'password'> | null {
  if (cred.kind !== 'imap_password' || !cred.imapHost || !cred.imapPort || !cred.imapTlsMode || !cred.imapUsername) {
    return null;
  }
  return { host: cred.imapHost, port: cred.imapPort, tlsMode: cred.imapTlsMode, username: cred.imapUsername };
}

/** The token to revoke on disconnect (refresh token preferred), or null. */
export async function loadRevocableToken(sourceId: string, db: DbOrTx = getDb()): Promise<string | null> {
  const [cred] = await db
    .select({ refreshTokenEnc: mailboxCredential.refreshTokenEnc, accessTokenEnc: mailboxCredential.accessTokenEnc })
    .from(mailboxCredential)
    .where(eq(mailboxCredential.sourceId, sourceId))
    .limit(1);
  const enc = cred?.refreshTokenEnc ?? cred?.accessTokenEnc;
  return enc ? open(enc) : null;
}

/** Fixed-token provider for the connect callback: no refresh token is stored yet. */
function staticTokens(tokens: OAuthTokens): TokenProvider {
  return {
    get: async () => tokens.accessToken,
    refresh: async () => {
      throw new MailAuthError();
    },
  };
}

/** Resolves the mailbox address right after the code exchange (Gmail profile, Graph /me). */
export async function resolveOAuthAddress(provider: MailOAuthProvider, tokens: OAuthTokens): Promise<string> {
  const tp = staticTokens(tokens);
  const address =
    provider === 'gmail'
      ? (await createGmailClient({ tokens: tp }).getProfile()).emailAddress
      : (await createGraphClient({ tokens: tp }).getMe()).address;
  return address.trim().toLowerCase();
}

/**
 * Decrypts the stored access token and refreshes it when it expires within 2 min or when a client asks
 * (401). New tokens are persisted; a failed refresh surfaces as `MailAuthError`. Concurrent refreshes share
 * one request.
 */
function storedTokenProvider(
  sourceId: string,
  provider: MailOAuthProvider,
  initial: { accessToken: string | null; refreshToken: string | null; expiresAt: Date | null },
): TokenProvider {
  let accessToken = initial.accessToken;
  let refreshToken = initial.refreshToken;
  let expiresAt = initial.expiresAt;
  let pending: Promise<string> | null = null;

  async function doRefresh(): Promise<string> {
    if (!refreshToken) throw new MailAuthError();
    const tokens = await refreshAccessToken(mailOAuthEnv(), provider, refreshToken);
    await saveOAuthCredential(getDb(), sourceId, tokens);
    accessToken = tokens.accessToken;
    expiresAt = tokens.expiresAt;
    if (tokens.refreshToken) refreshToken = tokens.refreshToken;
    return tokens.accessToken;
  }

  const refresh = (): Promise<string> => {
    pending ??= doRefresh().finally(() => {
      pending = null;
    });
    return pending;
  };

  return {
    async get() {
      const expiring = expiresAt !== null && expiresAt.getTime() - Date.now() < TOKEN_REFRESH_MARGIN_MS;
      if (!accessToken || expiring) return refresh();
      return accessToken;
    },
    refresh,
  };
}

/** Builds the provider fetcher for a source. A missing or unusable credential is a `MailAuthError`. */
export async function openFetcher(sourceId: string): Promise<MailFetcher> {
  const [row] = await getDb()
    .select({ type: connectedSource.type, cred: mailboxCredential })
    .from(connectedSource)
    .leftJoin(mailboxCredential, eq(mailboxCredential.sourceId, connectedSource.id))
    .where(eq(connectedSource.id, sourceId))
    .limit(1);
  const cred = row?.cred;
  if (!row || !cred) throw new MailAuthError('Mailbox credential missing');

  if (row.type === 'imap') {
    const settings = imapSettingsOf(cred);
    if (!settings || !cred.imapPasswordEnc) throw new MailAuthError('Mailbox credential missing');
    return createImapFetcher({ ...settings, password: open(cred.imapPasswordEnc) }, getImapOptions());
  }
  if (row.type !== 'gmail' && row.type !== 'microsoft') throw new MailAuthError('Not a mailbox source');
  if (cred.kind !== 'oauth') throw new MailAuthError('Mailbox credential missing');

  const tokens = storedTokenProvider(sourceId, row.type, {
    accessToken: cred.accessTokenEnc ? open(cred.accessTokenEnc) : null,
    refreshToken: cred.refreshTokenEnc ? open(cred.refreshTokenEnc) : null,
    expiresAt: cred.tokenExpiresAt,
  });
  return row.type === 'gmail'
    ? createGmailFetcher(createGmailClient({ tokens }))
    : createGraphFetcher(createGraphClient({ tokens }));
}

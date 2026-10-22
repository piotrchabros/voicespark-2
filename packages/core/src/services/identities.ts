import { and, asc, desc, eq } from 'drizzle-orm';
import {
  account,
  getDb,
  signInIdentity,
  SIGN_IN_PROVIDERS,
  withTransaction,
  type DbOrTx,
  type LinkedVia,
  type SignInProvider,
} from '@voicespark/db';
import { AppError, type ServiceContext } from '../errors';
import { audit } from './audit';

export const RELAY_EMAIL_SUFFIX = '@privaterelay.appleid.com';

export type LinkVia = 'confirmed_link' | 'manual_link';

export interface IdentityView {
  /** `account.id` */
  id: string;
  provider: SignInProvider;
  providerEmail: string | null;
  emailVerified: boolean;
  isRelayEmail: boolean;
  linkedAt: string;
  linkedVia: LinkedVia;
}

export type SocialLinker = (args: {
  provider: SignInProvider;
  callbackURL: string;
  errorCallbackURL: string;
}) => Promise<{ url: string }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRelayEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase().endsWith(RELAY_EMAIL_SUFFIX);
}

export function isSignInProvider(p: string): p is SignInProvider {
  return (SIGN_IN_PROVIDERS as readonly string[]).includes(p);
}

/** Confirm-linking is offered only for a verified, non-relay, non-Facebook identity (FR-003). */
export function canOfferLink(i: { provider: SignInProvider; emailVerified: boolean; isRelayEmail: boolean }): boolean {
  return i.emailVerified && !i.isRelayEmail && i.provider !== 'facebook';
}

/** `/link-account` only knows the pending provider: Facebook never gets the confirm offer (D-C10). */
export function canOfferLinkForProvider(provider: string): boolean {
  return isSignInProvider(provider) && provider !== 'facebook';
}

export async function listIdentities(ctx: ServiceContext): Promise<IdentityView[]> {
  const rows = await getDb()
    .select()
    .from(signInIdentity)
    .where(eq(signInIdentity.userId, ctx.userId))
    .orderBy(asc(signInIdentity.linkedAt));
  return rows.map((r) => ({
    id: r.accountId,
    provider: r.provider,
    providerEmail: r.providerEmail,
    emailVerified: r.emailVerified,
    isRelayEmail: r.isRelayEmail,
    linkedAt: r.linkedAt.toISOString(),
    linkedVia: r.linkedVia,
  }));
}

/** Called from Better Auth account hooks; non-sign-in providers (e.g. mail OAuth) are ignored. */
export async function recordIdentity(
  input: {
    accountId: string;
    userId: string;
    provider: string;
    email: string | null;
    emailVerified: boolean;
    linkedVia: 'signup' | 'manual_link';
  },
  db: DbOrTx = getDb(),
): Promise<void> {
  if (!isSignInProvider(input.provider)) return;
  await db
    .insert(signInIdentity)
    .values({
      accountId: input.accountId,
      userId: input.userId,
      provider: input.provider,
      providerEmail: input.email,
      // Facebook email verification is never trusted (R3).
      emailVerified: input.provider === 'facebook' ? false : input.emailVerified,
      isRelayEmail: isRelayEmail(input.email),
      linkedVia: input.linkedVia,
    })
    .onConflictDoNothing();
}

/** The linker wraps Better Auth `linkSocial` in the web app (D-C4); core cannot import the auth instance. */
export async function startLink(
  _ctx: ServiceContext,
  provider: SignInProvider,
  via: LinkVia,
  linker: SocialLinker,
): Promise<{ redirectUrl: string }> {
  if (!isSignInProvider(provider)) throw new AppError('validation_failed');
  const { url } = await linker({
    provider,
    callbackURL: `/api/identities/link/complete?provider=${provider}&via=${via}`,
    errorCallbackURL: '/settings/identities?error=link_failed',
  });
  return { redirectUrl: url };
}

export async function completeLink(
  ctx: ServiceContext,
  input: { provider: SignInProvider; via: LinkVia; providerEmail?: string | null; emailVerified?: boolean },
): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .select({ accountId: signInIdentity.accountId })
      .from(signInIdentity)
      .where(and(eq(signInIdentity.userId, ctx.userId), eq(signInIdentity.provider, input.provider)))
      .orderBy(desc(signInIdentity.linkedAt))
      .limit(1)
      .for('update');
    if (!row) throw new AppError('not_found');

    const set: Partial<typeof signInIdentity.$inferInsert> = { linkedVia: input.via };
    if (input.providerEmail !== undefined) {
      set.providerEmail = input.providerEmail;
      set.isRelayEmail = isRelayEmail(input.providerEmail);
    }
    if (input.emailVerified !== undefined) {
      set.emailVerified = input.provider === 'facebook' ? false : input.emailVerified;
    }
    await tx.update(signInIdentity).set(set).where(eq(signInIdentity.accountId, row.accountId));
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'auth.identity_linked',
        targetType: 'identity',
        targetId: row.accountId,
        metadata: { provider: input.provider, linkedVia: input.via },
      },
      tx,
    );
  });
}

/** Deletes the Better Auth `account` row; the identity cascades (D-C14). Never removes the last identity (FR-004). */
export async function unlink(ctx: ServiceContext, accountId: string): Promise<void> {
  if (!UUID_RE.test(accountId)) throw new AppError('not_found');
  await withTransaction(async (tx) => {
    const rows = await tx
      .select({ accountId: signInIdentity.accountId, provider: signInIdentity.provider })
      .from(signInIdentity)
      .where(eq(signInIdentity.userId, ctx.userId))
      .for('update');
    const target = rows.find((r) => r.accountId === accountId);
    if (!target) throw new AppError('not_found');
    if (rows.length === 1) throw new AppError('last_identity');

    await tx.delete(account).where(and(eq(account.id, accountId), eq(account.userId, ctx.userId)));
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'auth.identity_unlinked',
        targetType: 'identity',
        targetId: accountId,
        metadata: { provider: target.provider },
      },
      tx,
    );
  });
}

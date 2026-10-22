import { headers } from 'next/headers';
import { and, desc, eq } from 'drizzle-orm';
import { account, getDb } from '@voicespark/db';
import { loadEnv } from '@voicespark/core/env';
import { logger } from '@voicespark/core/logger';
import * as identities from '@voicespark/core/services/identities';
import { getAuth, NULLED_PROVIDER_TOKENS } from '../../../../../lib/auth';
import { requireUser } from '../../../../../lib/guards';
import { AppError, handle } from '../../../../../lib/http';

export const dynamic = 'force-dynamic';

const redirectTo = (path: string) =>
  Response.redirect(new URL(path, loadEnv().APP_URL).toString(), 303);

// Better Auth's link callback lands here (D-C4): stamp linked_via and refresh the provider email.
export const GET = handle(async (req) => {
  const ctx = await requireUser();
  const params = new URL(req.url).searchParams;
  const provider = params.get('provider') ?? '';
  const via = params.get('via') === 'confirmed_link' ? 'confirmed_link' : 'manual_link';
  if (!identities.isSignInProvider(provider))
    return redirectTo('/settings/identities?error=link_failed');

  try {
    // Best effort: the provider's current email and verification flag; the link itself already succeeded.
    let info: { providerEmail?: string | null; emailVerified?: boolean } = {};
    let accountId: string | undefined;
    try {
      const [row] = await getDb()
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, ctx.userId), eq(account.providerId, provider)))
        .orderBy(desc(account.createdAt))
        .limit(1);
      accountId = row?.id;
      if (accountId) {
        // better-auth 1.7 resolves `accountId` against the account ROW id (resolveUserAccount compares
        // candidate.id), not the provider's account id.
        const res = await getAuth().api.accountInfo({
          query: { accountId },
          headers: await headers(),
        });
        if (res?.user)
          info = { providerEmail: res.user.email ?? null, emailVerified: !!res.user.emailVerified };
      }
    } catch {
      logger.warn(
        { errorCode: 'account_info_unavailable' },
        'identity link: provider info not available',
      );
    }
    // The linked account's provider tokens served only the lookup above (FR-005, T164).
    if (accountId)
      await getDb().update(account).set(NULLED_PROVIDER_TOKENS).where(eq(account.id, accountId));
    await identities.completeLink(ctx, { provider, via, ...info });
  } catch (err) {
    if (err instanceof AppError && err.code === 'unauthenticated') throw err;
    logger.warn({ errorCode: 'link_failed' }, 'identity link completion failed');
    return redirectTo('/settings/identities?error=link_failed');
  }
  return redirectTo(
    via === 'confirmed_link' ? '/dashboard?linked=1' : '/settings/identities?linked=1',
  );
});

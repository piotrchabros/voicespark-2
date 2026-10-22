import Link from 'next/link';
import { headers } from 'next/headers';
import { canOfferLinkForProvider, isSignInProvider } from '@voicespark/core/services/identities';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProviderButtons } from '@/components/auth/provider-buttons';
import { getAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = { google: 'Google', apple: 'Apple', microsoft: 'Microsoft', facebook: 'Facebook' };

export default async function LinkAccountPage({ searchParams }: { searchParams: Promise<{ provider?: string }> }) {
  const { provider = '' } = await searchParams;
  const session = await getAuth().api.getSession({ headers: await headers() });
  const valid = isSignInProvider(provider);
  const label = LABELS[provider] ?? 'this provider';

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-2xl">An account already exists</CardTitle>
          <CardDescription>
            An account with this email already exists. Sign in with your existing provider first, then link{' '}
            {label} to it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!valid ? (
            <p className="text-sm">
              Unknown provider. <Link href="/sign-in" className="underline">Back to sign-in</Link>
            </p>
          ) : !session ? (
            <ProviderButtons
              mode="sign-in"
              callbackURL={`/link-account?provider=${provider}`}
              exclude={[provider]}
            />
          ) : canOfferLinkForProvider(provider) ? (
            <>
              <p className="text-sm">You are signed in. Confirm to link {label} to this account.</p>
              <LinkConfirm provider={provider} />
            </>
          ) : (
            <p className="text-sm">
              {label} cannot be linked automatically. You can link it manually from{' '}
              <Link href="/settings/identities" className="underline">
                Settings &gt; Identities
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function LinkConfirm({ provider }: { provider: string }) {
  // ProviderButtons renders every non-excluded provider, so exclude all others to show just the pending one.
  const others = (['google', 'apple', 'microsoft', 'facebook'] as const).filter((p) => p !== provider);
  return <ProviderButtons mode="link" via="confirmed_link" exclude={[...others]} />;
}

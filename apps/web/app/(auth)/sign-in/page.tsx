import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProviderButtons } from '@/components/auth/provider-buttons';
import { getAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  oauth_cancelled: 'You cancelled at the provider; no account was created.',
  oauth_failed: 'Sign-in with the provider failed. Please try again.',
  account_suspended: 'This account is suspended.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; deleted?: string }>;
}) {
  const { error, deleted } = await searchParams;
  // A still-valid session of a suspended user would bounce back from /dashboard; stay here and show the message.
  if (error !== 'account_suspended') {
    const session = await getAuth().api.getSession({ headers: await headers() });
    if (session) redirect('/dashboard');
  }
  const message = error ? MESSAGES[error] : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-2xl">Sign in to VoiceSpark</CardTitle>
          <CardDescription>Choose a provider. There are no passwords.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {deleted === '1' ? (
            <p role="status" className="rounded-md border p-3 text-sm">
              Your account deletion has started. You will receive a confirmation email when it is
              complete.
            </p>
          ) : null}
          {message ? (
            <p
              role="alert"
              className="border-destructive/50 text-destructive rounded-md border p-3 text-sm"
            >
              {message}
            </p>
          ) : null}
          <ProviderButtons mode="sign-in" callbackURL="/dashboard" />
          <p className="text-muted-foreground text-sm">
            Signing in does not give VoiceSpark access to your mailbox.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

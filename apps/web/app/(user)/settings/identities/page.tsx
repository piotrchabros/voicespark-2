import type { SignInProvider } from '@voicespark/db';
import * as identities from '@voicespark/core/services/identities';
import { IdentityList } from '@/components/auth/identity-list';
import { ProviderButtons } from '@/components/auth/provider-buttons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function IdentitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string; error?: string }>;
}) {
  const ctx = await requireUserOrRedirect();
  const [list, params] = await Promise.all([identities.listIdentities(ctx), searchParams]);
  const linked: SignInProvider[] = list.map((i) => i.provider);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Sign-in methods</h1>
      {params.linked ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          Provider linked.
        </p>
      ) : null}
      {params.error === 'link_failed' ? (
        <p role="alert" className="border-destructive/50 text-destructive rounded-md border p-3 text-sm">
          Linking failed. Please try again.
        </p>
      ) : null}
      <IdentityList identities={list} />
      {linked.length < 4 ? (
        <Card>
          <CardHeader>
            <CardTitle>Link another provider</CardTitle>
            <CardDescription>Sign in with any linked provider to reach this same account.</CardDescription>
          </CardHeader>
          <CardContent>
            <ProviderButtons mode="link" via="manual_link" exclude={linked} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

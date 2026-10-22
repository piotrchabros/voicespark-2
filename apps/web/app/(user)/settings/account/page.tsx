import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { getDb, user } from '@voicespark/db';
import { DeleteAccountDialog } from '@/components/account/delete-account-dialog';
import { DeletionStatus } from '@/components/account/deletion-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const ctx = await requireUserOrRedirect();
  const [row] = await getDb()
    .select({ name: user.name, email: user.email, role: user.role, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, ctx.userId))
    .limit(1);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Account settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="break-words">{row?.name || '-'}</dd>
            <dt className="text-muted-foreground mt-2 sm:mt-0">Email</dt>
            <dd className="break-all">{row?.email ?? '-'}</dd>
            <dt className="text-muted-foreground mt-2 sm:mt-0">Role</dt>
            <dd className="capitalize">{row?.role ?? ctx.role}</dd>
            <dt className="text-muted-foreground mt-2 sm:mt-0">Member since</dt>
            <dd>{row ? row.createdAt.toISOString().slice(0, 10) : '-'}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sign-in methods</CardTitle>
          <CardDescription>Link or unlink the providers you use to sign in.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/settings/identities">Manage sign-in methods</Link>
          </Button>
        </CardContent>
      </Card>
      <DeletionStatus />
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle>Delete account</CardTitle>
          <CardDescription>
            Permanently removes your account and all your data. You will receive a confirmation
            email when it is complete.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteAccountDialog />
        </CardContent>
      </Card>
    </div>
  );
}

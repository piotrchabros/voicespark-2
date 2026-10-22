import Link from 'next/link';
import * as filterPreferences from '@voicespark/core/services/filter-preferences';
import * as sources from '@voicespark/core/services/sources';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

// FR-061: until filters are confirmed, every first-import entry point goes through onboarding.
const gate = (confirmed: boolean, target: string) =>
  confirmed ? target : `/onboarding/filters?returnTo=${encodeURIComponent(target)}`;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ linked?: string }> }) {
  const ctx = await requireUserOrRedirect();
  const [prefs, list, params] = await Promise.all([filterPreferences.get(ctx), sources.list(ctx), searchParams]);
  const confirmed = prefs.confirmedAt !== null;
  const connectHref = gate(confirmed, '/sources/connect');
  const uploadHref = gate(confirmed, '/uploads');

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      {params.linked ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          Provider linked to your account.
        </p>
      ) : null}
      {list.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Welcome to VoiceSpark</CardTitle>
            <CardDescription>
              You have no sources and no voice profile yet. Connect a mailbox or upload files to get started.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row">
            <Button asChild>
              <Link href={connectHref}>Connect a mailbox</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={uploadHref}>Upload files</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Sources</CardTitle>
            <CardDescription>
              {list.length} connected {list.length === 1 ? 'source' : 'sources'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2">
              {list.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <Link href={`/sources/${s.id}`} className="font-medium break-all underline">
                    {s.accountLabel}
                  </Link>
                  <span className="text-muted-foreground">
                    {s.currentImport ? `Import ${s.currentImport.status}` : s.status} - {s.itemCount} items
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild>
                <Link href={connectHref}>Connect another mailbox</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={uploadHref}>Upload files</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

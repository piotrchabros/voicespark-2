import * as adminSystem from '@voicespark/core/services/admin-system';
import * as adminUsers from '@voicespark/core/services/admin-users';
import * as definitions from '@voicespark/core/services/definitions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

function parseDate(v: string | undefined, endOfDay: boolean): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const pct = (share: number | null) => (share === null ? 'n/a' : `${Math.round(share * 100)}%`);

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  // The layout renders the 403 page for non-admins, but pages are rendered in parallel with it.
  if (!(await requireAdminPage())) return null;
  const params = await searchParams;
  const from = parseDate(params.from, false);
  const to = parseDate(params.to, true);
  const [health, ratings, userCount, defs] = await Promise.all([
    adminSystem.health(),
    adminSystem.ratingsMetrics({ ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    adminUsers.count(),
    definitions.adminList(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Admin dashboard</h1>

      {health.overdueDeletions > 0 ? (
        <p
          role="alert"
          className="border-destructive text-destructive rounded-md border p-3 text-sm"
        >
          {health.overdueDeletions} deletion request(s) are past their deadline.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Users</CardDescription>
            <CardTitle>{userCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Definitions</CardDescription>
            <CardTitle>{defs.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Credential audit hits (7 days)</CardDescription>
            <CardTitle>{health.credentialAuditHits}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Queue health</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>Waiting</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Delayed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(health.queues).map(([name, c]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell>{c.waiting}</TableCell>
                  <TableCell>{c.active}</TableCell>
                  <TableCell>{c.failed}</TableCell>
                  <TableCell>{c.delayed}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Context Hub</CardTitle>
          <CardDescription>
            System-wide aggregates only; today is since UTC midnight.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {(
              [
                ['LLM calls today', health.hub.llmCallsToday],
                ['Input tokens today', health.hub.inputTokensToday],
                ['Output tokens today', health.hub.outputTokensToday],
                ['Threads pending', health.hub.threadsPending],
                ['Threads failed', health.hub.threadsFailed],
                ['Failed syncs', health.hub.syncFailed],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ratings</CardTitle>
          <CardDescription>Aggregate counts only.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1">
              <Label htmlFor="from">From</Label>
              <Input id="from" name="from" type="date" defaultValue={params.from ?? ''} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="to">To</Label>
              <Input id="to" name="to" type="date" defaultValue={params.to ?? ''} />
            </div>
            <Button type="submit">Apply</Button>
          </form>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Rated</TableHead>
                <TableHead>Sounds like me</TableHead>
                <TableHead>Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Profiles</TableCell>
                <TableCell>{ratings.profiles.rated}</TableCell>
                <TableCell>{ratings.profiles.soundsLikeMe}</TableCell>
                <TableCell>{pct(ratings.profiles.share)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Drafts</TableCell>
                <TableCell>{ratings.drafts.rated}</TableCell>
                <TableCell>{ratings.drafts.soundsLikeMe}</TableCell>
                <TableCell>{pct(ratings.drafts.share)}</TableCell>
              </TableRow>
              {Object.entries(ratings.drafts.byContentType).map(([type, c]) => (
                <TableRow key={type}>
                  <TableCell className="pl-6">Drafts: {type}</TableCell>
                  <TableCell>{c.rated}</TableCell>
                  <TableCell>{c.soundsLikeMe}</TableCell>
                  <TableCell>{pct(c.share)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

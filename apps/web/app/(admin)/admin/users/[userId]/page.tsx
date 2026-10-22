import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as adminUsers from '@voicespark/core/services/admin-users';
import { Forbidden } from '@/components/admin/forbidden';
import { UserActions } from '@/components/admin/user-actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const ctx = await requireAdminPage();
  if (!ctx) return <Forbidden />;

  const { userId } = await params;
  if (!z.uuid().safeParse(userId).success) notFound();
  let u;
  try {
    u = await adminUsers.detail(userId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/admin/users"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to users
        </Link>
        <h1 className="text-2xl font-semibold break-words">{u.name}</h1>
        <p className="text-sm text-muted-foreground break-all">{u.email}</p>
        <div className="flex flex-wrap gap-2">
          <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role}</Badge>
          <Badge variant={u.status === 'suspended' ? 'destructive' : 'outline'}>{u.status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Created {when(u.createdAt)}. Last sign-in {when(u.lastSignInAt)}.
          {u.suspendedAt ? ` Suspended ${when(u.suspendedAt)}.` : ''}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <UserActions userId={u.id} role={u.role} status={u.status} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sign-in identities</CardTitle>
        </CardHeader>
        <CardContent>
          {u.identities.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {u.identities.map((i, idx) => (
                <li key={`${i.provider}-${idx}`} className="break-all">
                  {i.provider}: {i.providerEmail ?? 'no email'} (
                  {i.verified ? 'verified' : 'unverified'})
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
        </CardHeader>
        <CardContent>
          {u.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Last sync</TableHead>
                    <TableHead>Import</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {u.sources.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{s.type}</TableCell>
                      <TableCell>{s.accountLabel}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{s.status}</Badge>
                      </TableCell>
                      <TableCell>{s.itemCount}</TableCell>
                      <TableCell>{when(s.lastSyncAt)}</TableCell>
                      <TableCell>
                        {s.currentImport
                          ? `${s.currentImport.status}: ${s.currentImport.itemsProcessed}${
                              s.currentImport.totalEstimate
                                ? ` of ${s.currentImport.totalEstimate}`
                                : ''
                            }`
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profiles</CardTitle>
        </CardHeader>
        <CardContent>
          {u.profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Definition</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Versions</TableHead>
                    <TableHead>Last generated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {u.profiles.map((p, idx) => (
                    <TableRow key={`${p.definitionName}-${idx}`}>
                      <TableCell>{p.definitionName}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{p.status}</Badge>
                      </TableCell>
                      <TableCell>{p.versionCount}</TableCell>
                      <TableCell>{when(p.lastGeneratedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

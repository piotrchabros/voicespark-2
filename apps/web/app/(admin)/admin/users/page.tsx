import Link from 'next/link';
import { USER_ROLES, USER_STATUS } from '@voicespark/db';
import * as adminUsers from '@voicespark/core/services/admin-users';
import { Forbidden } from '@/components/admin/forbidden';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

const PAGE_SIZE = 25;

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

const selectClass =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireAdminPage();
  if (!ctx) return <Forbidden />;

  const sp = await searchParams;
  const query = one(sp.query).trim().slice(0, 200);
  const role = USER_ROLES.find((r) => r === one(sp.role));
  const status = USER_STATUS.find((s) => s === one(sp.status));
  const cursor = one(sp.cursor);

  const result = await adminUsers.list({
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(query ? { query } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
  });

  const next = new URLSearchParams();
  if (query) next.set('query', query);
  if (role) next.set('role', role);
  if (status) next.set('status', status);
  if (result.nextCursor) next.set('cursor', result.nextCursor);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <form method="GET" className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          name="query"
          defaultValue={query}
          placeholder="Search name or email"
          maxLength={200}
          className="sm:max-w-xs"
        />
        <select name="role" defaultValue={role ?? ''} className={selectClass} aria-label="Role">
          <option value="">All roles</option>
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={status ?? ''}
          className={selectClass}
          aria-label="Status"
        >
          <option value="">All statuses</option>
          {USER_STATUS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Button type="submit">Filter</Button>
      </form>
      {result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No users found.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Providers</TableHead>
                <TableHead>Sources</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last sign-in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {u.name}
                    </Link>
                  </TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>
                    <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.status === 'suspended' ? 'destructive' : 'outline'}>
                      {u.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{u.providers.join(', ') || '-'}</TableCell>
                  <TableCell>{u.sourceCount}</TableCell>
                  <TableCell>{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString() : 'Never'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {result.nextCursor ? (
        <div>
          <Button asChild variant="outline">
            <Link href={`/admin/users?${next.toString()}`}>Next</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

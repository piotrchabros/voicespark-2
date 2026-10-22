import Link from 'next/link';
import * as adminSystem from '@voicespark/core/services/admin-system';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Forbidden } from '@/components/admin/forbidden';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const FILTERS = ['action', 'targetType', 'targetId', 'actorUserId', 'from', 'to'] as const;
type FilterKey = (typeof FILTERS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const LABELS: Record<FilterKey, string> = {
  action: 'Action',
  targetType: 'Target type',
  targetId: 'Target id',
  actorUserId: 'Actor id',
  from: 'From',
  to: 'To',
};

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireAdminPage();
  if (!admin) return <Forbidden />;

  const raw = await searchParams;
  const param = (k: string): string => {
    const v = raw[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
  };
  const values = Object.fromEntries(FILTERS.map((k) => [k, param(k)])) as Record<FilterKey, string>;
  const cursor = param('cursor');

  const from = DAY.test(values.from) ? new Date(`${values.from}T00:00:00.000Z`) : null;
  const to = DAY.test(values.to) ? new Date(`${values.to}T23:59:59.999Z`) : null;

  const page = await adminSystem.auditQuery({
    ...(values.action ? { action: values.action } : {}),
    ...(values.targetType ? { targetType: values.targetType } : {}),
    ...(values.targetId ? { targetId: values.targetId } : {}),
    ...(UUID.test(values.actorUserId) ? { actorUserId: values.actorUserId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(cursor ? { cursor } : {}),
    limit: PAGE_SIZE,
  });

  const next = new URLSearchParams();
  for (const k of FILTERS) if (values[k]) next.set(k, values[k]);
  if (page.nextCursor) next.set('cursor', page.nextCursor);

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-muted-foreground text-sm">
          Who did what, and to which record. Only the names of metadata fields are shown, never
          their values.
        </p>
      </div>

      <form method="get" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FILTERS.map((k) => (
          <div key={k} className="flex flex-col gap-1">
            <Label htmlFor={`audit-${k}`}>{LABELS[k]}</Label>
            <Input
              id={`audit-${k}`}
              name={k}
              type={k === 'from' || k === 'to' ? 'date' : 'text'}
              defaultValue={values[k]}
            />
          </div>
        ))}
        <div className="flex items-end gap-2">
          <Button type="submit">Filter</Button>
          <Button asChild variant="outline">
            <Link href="/admin/audit">Reset</Link>
          </Button>
        </div>
      </form>

      {page.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No audit entries match.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Metadata keys</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap">
                  {new Date(e.occurredAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Badge variant="outline" className="w-fit">
                      {e.actorType}
                    </Badge>
                    {e.actor ? <span className="text-xs">{e.actor.name ?? e.actor.id}</span> : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{e.action}</TableCell>
                <TableCell className="text-xs">
                  {e.targetType ? (
                    <span className="break-all">
                      {e.targetType}
                      {e.targetId ? ` / ${e.targetId}` : ''}
                    </span>
                  ) : (
                    '-'
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {e.metadataKeys.length ? e.metadataKeys.join(', ') : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {page.nextCursor ? (
        <div>
          <Button asChild variant="outline">
            <Link href={`/admin/audit?${next.toString()}`}>Next</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

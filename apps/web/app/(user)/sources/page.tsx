import Link from 'next/link';
import * as sources from '@voicespark/core/services/sources';
import { SourceActions } from '@/components/sources/source-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  microsoft: 'Microsoft 365',
  imap: 'IMAP',
  uploads: 'Uploads',
};

export default async function SourcesPage() {
  const ctx = await requireUserOrRedirect();
  const list = await sources.list(ctx);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Sources</h1>
        <Button asChild>
          <Link href="/sources/connect">Connect a mailbox</Link>
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sources yet.</p>
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
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((s) => {
                const imp = s.currentImport;
                const percent = imp?.totalEstimate
                  ? Math.min(100, Math.round((imp.itemsProcessed / imp.totalEstimate) * 100))
                  : 0;
                return (
                  <TableRow key={s.id}>
                    <TableCell>{TYPE_LABELS[s.type] ?? s.type}</TableCell>
                    <TableCell className="break-all">
                      <Link href={`/sources/${s.id}`} className="underline">
                        {s.accountLabel}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={s.status === 'needs_reconnection' ? 'destructive' : 'secondary'}
                      >
                        {s.status.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell>{s.itemCount}</TableCell>
                    <TableCell>
                      {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'Never'}
                    </TableCell>
                    <TableCell className="min-w-32">
                      {imp ? (
                        <div className="flex flex-col gap-1">
                          <Progress value={percent} aria-label="Import progress" />
                          <span className="text-xs text-muted-foreground">
                            {imp.status}, {imp.itemsProcessed} processed
                          </span>
                        </div>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell>
                      <SourceActions
                        sourceId={s.id}
                        type={s.type}
                        status={s.status}
                        accountLabel={s.accountLabel}
                        itemCount={s.itemCount}
                        lastSyncAt={s.lastSyncAt ? new Date(s.lastSyncAt).toISOString() : null}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import * as sources from '@voicespark/core/services/sources';
import { ExclusionSummary } from '@/components/exclusion-summary';
import { ImportProgress } from '@/components/sources/import-progress';
import { SourceActions } from '@/components/sources/source-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function SourceDetailPage({ params }: { params: Promise<{ sourceId: string }> }) {
  const ctx = await requireUserOrRedirect();
  const { sourceId } = await params;
  let source: Awaited<ReturnType<typeof sources.get>>;
  try {
    source = await sources.get(ctx, sourceId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }

  const latestFinished = source.recentImports.find((i) => ['completed', 'failed', 'cancelled'].includes(i.status));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/sources" className="text-sm underline">
          All sources
        </Link>
        <h1 className="text-2xl font-semibold break-all">{source.accountLabel}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={source.status === 'needs_reconnection' ? 'destructive' : 'secondary'}>
            {source.status.replace('_', ' ')}
          </Badge>
          <span className="text-muted-foreground">
            {source.itemCount} items, last sync {formatDate(source.lastSyncAt)}
          </span>
        </div>
        <SourceActions
          sourceId={source.id}
          type={source.type}
          status={source.status}
          accountLabel={source.accountLabel}
          itemCount={source.itemCount}
          lastSyncAt={source.lastSyncAt}
        />
      </div>

      {source.status === 'needs_reconnection' ? (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle>This source needs reconnection</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            Access was lost, so syncing is paused. Use Reconnect above to resume; your imported content is kept.
          </CardContent>
        </Card>
      ) : null}

      {source.currentImport ? (
        <Card>
          <CardHeader>
            <CardTitle>Current import</CardTitle>
          </CardHeader>
          <CardContent>
            <ImportProgress key={source.currentImport.id} initial={source.currentImport} />
          </CardContent>
        </Card>
      ) : null}

      {latestFinished ? (
        <Card>
          <CardHeader>
            <CardTitle>Exclusion summary</CardTitle>
          </CardHeader>
          <CardContent>
            <ExclusionSummary importJobId={latestFinished.id} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Import history</CardTitle>
        </CardHeader>
        <CardContent>
          {source.recentImports.length === 0 ? (
            <p className="text-sm text-muted-foreground">No imports yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {source.recentImports.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {i.kind} import <Badge variant="outline">{i.status}</Badge>
                  </span>
                  <span className="text-muted-foreground">
                    {i.itemsImported} imported, {i.itemsExcluded} excluded - {formatDate(i.finishedAt ?? i.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Button asChild variant="outline" className="sm:self-start">
        <Link href="/sources">Back to sources</Link>
      </Button>
    </div>
  );
}

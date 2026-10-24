'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { KIND_LABELS, STATUS_LABELS, type HubKind, type HubRecord } from './labels';

export interface RecordListItem extends HubRecord {
  linkCounts: { people?: number; companies?: number; projects?: number } | number;
  noteCount: number;
  fileCount: number;
}

export type HubSort = 'name' | 'updated';
export type HubOrder = 'asc' | 'desc';

function pageHref(kind: HubKind, sort: HubSort, order: HubOrder, cursor?: string): string {
  const q: Record<string, string> = { sort, order };
  if (cursor) q.cursor = cursor;
  return `/hub/${kind}?${new URLSearchParams(q).toString()}`;
}

function totalLinks(c: RecordListItem['linkCounts']): number {
  return typeof c === 'number' ? c : Object.values(c).reduce<number>((a, b) => a + (b ?? 0), 0);
}

// FR-006: list sorted by name or last change (sorted by the server; changing the sort re-queries it), with counts
// and cursor paging.
export function RecordList({
  kind,
  items,
  nextCursor,
  sort,
  order,
}: {
  kind: HubKind;
  items: RecordListItem[];
  nextCursor: string | null;
  sort: HubSort;
  order: HubOrder;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <Label htmlFor="hub-sort">Sort by</Label>
        <select
          id="hub-sort"
          value={sort}
          onChange={(e) => {
            const next = e.target.value as HubSort;
            router.push(pageHref(kind, next, next === 'name' ? 'asc' : 'desc'));
          }}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="name">Name</option>
          <option value="updated">Last change</option>
        </select>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {KIND_LABELS[kind].plural.toLowerCase()} yet.
        </p>
      ) : (
        <ul className="divide-y rounded-md border" aria-label={KIND_LABELS[kind].plural}>
          {items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="flex flex-col gap-0.5">
                <Link
                  href={`/hub/${kind}/${r.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {r.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  Changed {new Date(r.updatedAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {kind === 'projects' && r.status ? (
                  <Badge variant="outline">{STATUS_LABELS[r.status]}</Badge>
                ) : null}
                <Badge variant="secondary">{totalLinks(r.linkCounts)} links</Badge>
                <Badge variant="secondary">{r.noteCount} notes</Badge>
                <Badge variant="secondary">{r.fileCount} files</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
      {nextCursor ? (
        <div>
          <Button asChild variant="outline" size="sm">
            <Link href={pageHref(kind, sort, order, nextCursor)}>Next page</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

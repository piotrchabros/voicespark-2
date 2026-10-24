import Link from 'next/link';
import { list } from '@voicespark/core/services/hub/records';
import { requireUserOrRedirect } from '@/lib/page-auth';
import { Button } from '@/components/ui/button';
import {
  RecordList,
  type HubOrder,
  type HubSort,
  type RecordListItem,
} from './record-list';
import { KIND_LABELS, type HubKind } from './labels';

const SERVICE_KIND = { people: 'person', companies: 'company', projects: 'project' } as const;

// Shared by the three list pages (FR-006): sorted by name by default, cursor paging through the query string.
export async function RecordListPage({
  kind,
  searchParams,
}: {
  kind: HubKind;
  searchParams: Promise<{ sort?: string; order?: string; cursor?: string }>;
}) {
  const ctx = await requireUserOrRedirect();
  const q = await searchParams;
  const sort: HubSort = q.sort === 'updated' ? 'updated' : 'name';
  const order: HubOrder =
    q.order === 'asc' || q.order === 'desc' ? q.order : sort === 'name' ? 'asc' : 'desc';
  const { items, nextCursor } = await list(ctx, SERVICE_KIND[kind], {
    sort,
    order,
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{KIND_LABELS[kind].plural}</h1>
        <Button asChild>
          <Link href={`/hub/${kind}/new`}>New {KIND_LABELS[kind].singular}</Link>
        </Button>
      </div>
      <RecordList
        kind={kind}
        items={items as RecordListItem[]}
        nextCursor={nextCursor}
        sort={sort}
        order={order}
      />
    </div>
  );
}

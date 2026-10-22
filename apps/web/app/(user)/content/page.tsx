import { redirect } from 'next/navigation';
import { FILTER_CATEGORIES as CATEGORY_DEFS } from '@voicespark/filters';
import { AppError } from '@voicespark/core/errors';
import * as contentItems from '@voicespark/core/services/content-items';
import * as sources from '@voicespark/core/services/sources';
import { ContentList } from '@/components/content/content-list';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{
    sourceId?: string | string[];
    query?: string | string[];
    cursor?: string | string[];
  }>;
}) {
  const ctx = await requireUserOrRedirect();
  const params = await searchParams;
  const sourceId = first(params.sourceId);
  const query = first(params.query);
  const cursor = first(params.cursor);

  let page: Awaited<ReturnType<typeof contentItems.list>>;
  try {
    page = await contentItems.list(ctx, {
      limit: PAGE_SIZE,
      ...(sourceId ? { sourceId } : {}),
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });
  } catch (err) {
    // A stale or tampered cursor restarts from the first page.
    if (err instanceof AppError && err.code === 'validation_failed') redirect('/content');
    throw err;
  }
  const sourceList = await sources.list(ctx);

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Content</h1>
        <p className="text-muted-foreground text-sm">
          Everything stored for your voice profile. Report an item as sensitive to remove it and
          record the miss.
        </p>
      </div>
      <ContentList
        items={page.items}
        nextCursor={page.nextCursor}
        sources={sourceList.map((s) => ({ id: s.id, label: s.accountLabel }))}
        categories={CATEGORY_DEFS.map((c) => ({ key: c.key, label: c.label }))}
        filters={{ sourceId: sourceId ?? null, query: query ?? '', paged: cursor !== undefined }}
      />
    </div>
  );
}

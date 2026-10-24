import { search } from '@voicespark/core/services/hub/search';
import { requireUserOrRedirect } from '@/lib/page-auth';
import { SearchResults } from '@/components/hub/search-results';
import { parseSearchTypes, SEARCH_QUERY_MAX, type HubSearchItem } from '@/components/hub/labels';

export const dynamic = 'force-dynamic';

// Keyword search over the user's own hub (US5, FR-011). The query lives in the URL, so results are shareable with
// oneself and the type chips are plain links.
export default async function HubSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; types?: string; cursor?: string }>;
}) {
  const ctx = await requireUserOrRedirect();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, SEARCH_QUERY_MAX);
  const types = parseSearchTypes(sp.types);

  let items: HubSearchItem[] = [];
  let nextCursor: string | null = null;
  if (q) {
    const result = await search(ctx, {
      q,
      ...(types.length ? { types } : {}),
      ...(sp.cursor ? { cursor: sp.cursor } : {}),
    });
    items = result.items as HubSearchItem[];
    nextCursor = result.nextCursor;
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{q ? `Results for “${q}”` : 'Search'}</h1>
      <SearchResults q={q} types={types} items={items} nextCursor={nextCursor} />
    </div>
  );
}

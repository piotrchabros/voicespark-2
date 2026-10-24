'use client';

import type { FormEvent, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  SEARCH_QUERY_MAX,
  SEARCH_TYPE_FILTERS,
  SEARCH_TYPE_LABELS,
  parseSearchTypes,
  searchResultHref,
  type HubSearchItem,
  type HubSearchSnippet,
  type HubSearchType,
} from './labels';

const SEARCH_PATH = '/hub/search';

function searchHref(q: string, types: HubSearchType[], cursor?: string): string {
  const params = new URLSearchParams({ q });
  if (types.length) params.set('types', types.join(','));
  if (cursor) params.set('cursor', cursor);
  return `${SEARCH_PATH}?${params.toString()}`;
}

/** Snippet text with `<mark>` around each highlight range, built from offsets (never from HTML). */
function Highlighted({ text, highlights }: HubSearchSnippet): ReactNode {
  const ranges = highlights
    .filter(([s, e]) => Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s)
    .sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    const s = Math.max(start, pos);
    const e = Math.min(end, text.length);
    if (e <= s) continue;
    if (s > pos) parts.push(text.slice(pos, s));
    parts.push(<mark key={s}>{text.slice(s, e)}</mark>);
    pos = e;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

/** Same text on the server and in the browser (no locale), so the row hydrates without a mismatch. */
const changedOn = (iso: string) => iso.slice(0, 10);

// The hub search box (layout). Submitting opens the search screen; the current type filter is kept.
export function HubSearchBox() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const onSearchPage = pathname === SEARCH_PATH;
  const current = onSearchPage ? (params.get('q') ?? '') : '';

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get('q') ?? '')
      .trim()
      .slice(0, SEARCH_QUERY_MAX);
    if (!q) return;
    const types = onSearchPage ? parseSearchTypes(params.get('types') ?? undefined) : [];
    router.push(searchHref(q, types));
  }

  return (
    <form role="search" onSubmit={submit} className="flex items-center gap-2">
      {/* Uncontrolled; the key remounts the box with the query from the URL when it changes. */}
      <Input
        key={current}
        type="search"
        name="q"
        aria-label="Search hub"
        placeholder="Search your hub"
        maxLength={SEARCH_QUERY_MAX}
        defaultValue={current}
        className="w-full sm:w-64"
      />
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}

// Type filter chips, result rows (type, title, owner record and snippets) and the next page link (FR-011).
export function SearchResults({
  q,
  types,
  items,
  nextCursor,
}: {
  q: string;
  types: HubSearchType[];
  items: HubSearchItem[];
  nextCursor: string | null;
}) {
  if (!q) {
    return (
      <p className="text-muted-foreground text-sm">
        Type a word to search your people, companies, projects, notes and files.
      </p>
    );
  }

  const chips = [{ type: null as HubSearchType | null, label: 'All' }, ...SEARCH_TYPE_FILTERS];
  const active = types.length === 1 ? types[0]! : null;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Filter by type">
        <ul className="flex flex-wrap gap-2">
          {chips.map((c) => {
            const selected = c.type === active;
            return (
              <li key={c.label}>
                <Link
                  href={searchHref(q, c.type ? [c.type] : [])}
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'hover:bg-accent inline-flex rounded-full border px-3 py-1 text-sm',
                    selected && 'bg-accent font-medium',
                  )}
                >
                  {c.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {items.length === 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          No results for &ldquo;{q}&rdquo;.
        </p>
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Search results">
          {items.map((item) => (
            <li key={`${item.type}:${item.id}`} className="flex flex-col gap-1 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{SEARCH_TYPE_LABELS[item.type]}</Badge>
                <Link
                  href={searchResultHref(item)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {item.title || `Untitled ${SEARCH_TYPE_LABELS[item.type].toLowerCase()}`}
                </Link>
                {item.owner ? (
                  <span className="text-muted-foreground text-sm">
                    in{' '}
                    <Link href={searchResultHref(item)} className="underline underline-offset-4">
                      {item.owner.name}
                    </Link>
                  </span>
                ) : null}
              </div>
              {item.snippets.map((s, i) => (
                <p key={i} className="text-sm">
                  <Highlighted text={s.text} highlights={s.highlights} />
                </p>
              ))}
              <span className="text-muted-foreground text-xs">Changed {changedOn(item.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <Button asChild variant="outline" className="self-start">
          <Link href={searchHref(q, types, nextCursor)}>More results</Link>
        </Button>
      ) : null}
    </div>
  );
}

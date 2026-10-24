'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SEARCH_QUERY_MAX, SEARCH_TYPE_LABELS, type HubSearchItem, type ServiceKind } from './labels';

/** The record a draft is pinned to (FR-027). */
export interface PickedRecord {
  kind: ServiceKind;
  id: string;
  name: string;
}

const LIMIT = 10;
const DEBOUNCE_MS = 250;

type Results = { q: string; items: HubSearchItem[] } | { q: string; failed: true };

// Search-as-you-type over the user's own people, companies and projects (GET /api/hub/search). Typing is debounced so
// the search rate limit is not spent per key.
export function RecordPicker({
  value,
  onChange,
  disabled,
}: {
  value: PickedRecord | null;
  onChange: (next: PickedRecord | null) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, types: 'person,company,project', limit: String(LIMIT) });
        const res = await fetch(`/api/hub/search?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('search');
        const data = (await res.json()) as { items: HubSearchItem[] };
        if (!cancelled) setResults({ q, items: data.items.filter((i) => i.owner === null) });
      } catch {
        if (!cancelled) setResults({ q, failed: true });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm" data-testid="picked-record">
        <span className="text-muted-foreground">{SEARCH_TYPE_LABELS[value.kind]}:</span>
        <span className="font-medium break-words">{value.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="ml-auto"
          onClick={() => onChange(null)}
        >
          Remove
        </Button>
      </div>
    );
  }

  const current = q && results?.q === q ? results : null;

  return (
    <div className="flex flex-col gap-2">
      <Input
        id={inputId}
        type="search"
        aria-label="Search people, companies and projects"
        aria-controls={listId}
        placeholder="Search people, companies and projects"
        maxLength={SEARCH_QUERY_MAX}
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full sm:w-96"
      />
      {q ? (
        current === null ? (
          <p className="text-muted-foreground text-xs" aria-live="polite">
            Searching...
          </p>
        ) : 'failed' in current ? (
          <p className="text-destructive text-xs" aria-live="polite">
            Search is unavailable right now. Try again shortly.
          </p>
        ) : current.items.length === 0 ? (
          <p className="text-muted-foreground text-xs" aria-live="polite">
            No matching records.
          </p>
        ) : (
          <ul id={listId} aria-label="Matching records" className="flex flex-col divide-y rounded-md border">
            {current.items.map((item) => (
              <li key={`${item.type}:${item.id}`}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange({ kind: item.type as ServiceKind, id: item.id, name: item.title });
                    setQuery('');
                  }}
                  className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                >
                  <span className="text-muted-foreground text-xs">{SEARCH_TYPE_LABELS[item.type]}</span>
                  <span className="break-words">{item.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

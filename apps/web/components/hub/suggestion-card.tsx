'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DECIDE_ERROR_TEXT,
  DECIDE_MAX_IDS,
  FIELD_LABELS,
  formatDay,
  hubApiError,
  KIND_PATH,
  STATUS_LABELS,
  SUGGESTION_REASON_TEXT,
  SUGGESTIONS_CHANGED_EVENT,
  type DecideAction,
  type DecideResult,
  type ProjectStatus,
  type SuggestionItem,
  type SuggestionPage,
} from './labels';

// The suggestion queue (US4; FR-023): each card shows the change, the current value, the conflict flag, the
// confidence and the conversations it came from, with Accept and Reject. A selection decides many at once; the
// server answers per id, and a selected link whose record is still a suggestion applies that record first.

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const objectOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const fieldLabel = (field: string | null) => (field ? (FIELD_LABELS[field] ?? field) : 'value');

/** The name a record-creating suggestion proposes. */
function proposedName(item: SuggestionItem): string | null {
  return str(objectOf(item.proposed).name) ?? item.target.label;
}

/** One line saying what the suggestion changes; `parent` is the pending record a link waits for. */
export function suggestionTitle(item: SuggestionItem, parent?: SuggestionItem): string {
  const draft = objectOf(item.proposed);
  const label = item.target.label ?? 'this record';
  switch (item.type) {
    case 'person':
      return `Add person ${proposedName(item) ?? ''}`.trim();
    case 'company':
      return `Add company ${proposedName(item) ?? ''}`.trim();
    case 'project':
      return `Add project ${proposedName(item) ?? ''}`.trim();
    case 'person_email':
      return `Add email ${str(draft.address) ?? ''} to ${label}`.replace(/\s+/g, ' ');
    case 'company_domain':
      return `Add domain ${str(draft.domain) ?? ''} to ${label}`.replace(/\s+/g, ' ');
    case 'field':
      return `Set ${fieldLabel(item.field)} of ${label}`;
    case 'link': {
      const ends = [item.target.label];
      if (parent) ends.push(`${proposedName(parent) ?? 'a new record'} (new ${parent.target.kind})`);
      const named = ends.filter((e): e is string => e !== null);
      return named.length ? `Link ${named.join(' – ')}` : 'Link two records';
    }
    case 'link_role':
      return `Set role of the link ${label}`;
  }
}

/** The proposed value as text. */
function proposedText(item: SuggestionItem): string {
  const p = item.proposed;
  const draft = objectOf(p);
  switch (item.type) {
    case 'field':
      return str(p) ?? JSON.stringify(p);
    case 'link_role':
      return str(p) ?? '';
    case 'link':
      return str(draft.role) ? `Role: ${str(draft.role)}` : 'No role';
    case 'person':
      return [str(draft.name), str(draft.email)].filter(Boolean).join(' · ');
    case 'company':
      return [str(draft.name), str(draft.domain)].filter(Boolean).join(' · ');
    case 'project': {
      const status = str(draft.status);
      return [str(draft.name), status ? (STATUS_LABELS[status as ProjectStatus] ?? status) : null, str(draft.description)]
        .filter(Boolean)
        .join(' · ');
    }
    case 'person_email':
      return str(draft.address) ?? '';
    case 'company_domain':
      return str(draft.domain) ?? '';
  }
}

/** Only a field or a link role replaces a value; the rest adds something. */
const hasCurrent = (item: SuggestionItem) => item.type === 'field' || item.type === 'link_role';

function recordHref(item: SuggestionItem): string | null {
  if (item.target.kind === 'link' || !item.target.id) return null;
  return `/hub/${KIND_PATH[item.target.kind]}/${item.target.id}`;
}

export function SuggestionCard({
  item,
  parent,
  selected,
  busy,
  onSelect,
  onDecide,
}: {
  item: SuggestionItem;
  parent?: SuggestionItem;
  selected: boolean;
  busy: boolean;
  onSelect: (selected: boolean) => void;
  onDecide: (action: DecideAction) => void;
}) {
  const title = suggestionTitle(item, parent);
  const href = recordHref(item);
  const current = str(item.current);
  return (
    <li data-suggestion-id={item.id} data-suggestion-type={item.type}>
      <article aria-label={title} className="flex flex-col gap-3 rounded-md border p-3">
        <div className="flex items-start gap-3">
          <Checkbox
            checked={selected}
            disabled={busy}
            onCheckedChange={(v) => onSelect(v === true)}
            aria-label={`Select ${title}`}
            className="mt-1"
          />
          <div className="flex-1 space-y-1">
            <h3 className="font-medium">{title}</h3>
            <div className="flex flex-wrap gap-2">
              {item.conflict ? <Badge variant="destructive">Conflict</Badge> : null}
              {item.reason ? <Badge variant="outline">{SUGGESTION_REASON_TEXT[item.reason]}</Badge> : null}
              <Badge variant="secondary">Confidence {Math.round(item.confidence * 100)}%</Badge>
              {item.dependsOn ? <Badge variant="outline">Applies the new record first</Badge> : null}
            </div>
          </div>
        </div>

        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Proposed</dt>
            <dd data-proposed>{proposedText(item)}</dd>
          </div>
          {hasCurrent(item) ? (
            <div>
              <dt className="text-muted-foreground">Current</dt>
              <dd data-current className={current ? undefined : 'text-muted-foreground'}>
                {current ?? 'Empty'}
              </dd>
            </div>
          ) : null}
        </dl>
        {href && item.target.label ? (
          <Link href={href} className="text-sm underline">
            Open {item.target.label}
          </Link>
        ) : null}

        <section aria-label={`Sources of ${title}`} className="space-y-1">
          <p className="text-muted-foreground text-xs">From</p>
          {item.sources.length === 0 ? (
            <p className="text-muted-foreground text-sm">The conversation is no longer available.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {item.sources.map((s) => (
                <li key={s.threadId}>
                  <span>{s.subject || 'Untitled conversation'}</span>
                  <span className="text-muted-foreground text-xs"> {formatDay(s.lastMessageAt)}</span>
                  {s.evidence ? (
                    <blockquote className="text-muted-foreground mt-1 border-l-2 pl-2 italic">{s.evidence}</blockquote>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => onDecide('accept')}>
            Accept
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide('reject')}>
            Reject
          </Button>
        </div>
      </article>
    </li>
  );
}

function resultText(r: DecideResult): string {
  if (r.status === 'accepted') return 'Accepted';
  if (r.status === 'rejected') return 'Rejected';
  const why = r.errorCode ? (DECIDE_ERROR_TEXT[r.errorCode] ?? r.errorCode) : 'unknown error';
  return `Not applied: ${why}`;
}

function summaryOf(results: DecideResult[]): string {
  const tally = { accepted: 0, rejected: 0, failed: 0 };
  for (const r of results) tally[r.status] += 1;
  const parts: string[] = [];
  if (tally.accepted) parts.push(`${tally.accepted} accepted`);
  if (tally.rejected) parts.push(`${tally.rejected} rejected`);
  if (tally.failed) parts.push(`${tally.failed} not applied`);
  return `${parts.join(', ')}.`;
}

export function SuggestionQueue({ initial }: { initial: SuggestionPage }) {
  const [items, setItems] = useState(initial.items);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [results, setResults] = useState<{ title: string; result: DecideResult }[] | null>(null);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const titleOf = (id: string) => {
    const item = byId.get(id);
    return item ? suggestionTitle(item, item.dependsOn ? byId.get(item.dependsOn) : undefined) : id;
  };

  async function fetchPage(cursor?: string): Promise<SuggestionPage | null> {
    try {
      const res = await fetch(`/api/hub/suggestions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
        cache: 'no-store',
      });
      if (!res.ok) return null;
      return (await res.json()) as SuggestionPage;
    } catch {
      return null;
    }
  }

  async function reload() {
    const page = await fetchPage();
    if (!page) {
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setItems(page.items);
    setNextCursor(page.nextCursor);
    setSelected((prev) => new Set([...prev].filter((id) => page.items.some((i) => i.id === id))));
  }

  async function loadMore() {
    if (!nextCursor) return;
    setBusy(true);
    const page = await fetchPage(nextCursor);
    setBusy(false);
    if (!page) {
      toast.error('Could not load more suggestions. Try again.');
      return;
    }
    setItems((prev) => [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))]);
    setNextCursor(page.nextCursor);
  }

  async function decide(ids: string[], action: DecideAction) {
    if (ids.length === 0) return;
    if (ids.length > DECIDE_MAX_IDS) {
      toast.error(`Choose at most ${DECIDE_MAX_IDS} suggestions at a time.`);
      return;
    }
    const titles = new Map(ids.map((id) => [id, titleOf(id)]));
    setBusy(true);
    try {
      const res = await fetch('/api/hub/suggestions/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, action }),
      });
      if (!res.ok) {
        toast.error(await hubApiError(res));
        return;
      }
      const data = (await res.json()) as { results: DecideResult[] };
      setResults(data.results.map((r) => ({ title: titles.get(r.id) ?? r.id, result: r })));
      toast.success(summaryOf(data.results));
      window.dispatchEvent(new Event(SUGGESTIONS_CHANGED_EVENT));
      await reload();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someSelected = selected.size > 0;

  return (
    <div className="flex flex-col gap-4">
      {results ? (
        <section aria-label="Decision results" className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <h2 className="font-medium">Results</h2>
          <ul className="flex flex-col gap-1">
            {results.map(({ title, result }) => (
              <li key={result.id} data-result-id={result.id} data-result-status={result.status}>
                {title}: {resultText(result)}
              </li>
            ))}
          </ul>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setResults(null)}>
              Dismiss
            </Button>
          </div>
        </section>
      ) : null}

      {loadFailed ? (
        <p role="alert" className="text-destructive text-sm">
          Could not load the suggestions.{' '}
          <button type="button" className="underline" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No suggestions waiting.</p>
      ) : (
        <>
          <div role="toolbar" aria-label="Bulk actions" className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                disabled={busy}
                onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
                aria-label="Select all shown"
              />
              <span>{selected.size} selected</span>
            </label>
            <Button size="sm" disabled={busy || !someSelected} onClick={() => void decide([...selected], 'accept')}>
              Accept selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !someSelected}
              onClick={() => void decide([...selected], 'reject')}
            >
              Reject selected
            </Button>
          </div>
          <ul aria-label="Suggestions" className="flex flex-col gap-3">
            {items.map((item) => (
              <SuggestionCard
                key={item.id}
                item={item}
                parent={item.dependsOn ? byId.get(item.dependsOn) : undefined}
                selected={selected.has(item.id)}
                busy={busy}
                onSelect={(on) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })
                }
                onDecide={(action) => void decide([item.id], action)}
              />
            ))}
          </ul>
          {nextCursor ? (
            <div>
              <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

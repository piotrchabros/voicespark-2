'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface ContentItem {
  id: string;
  kind: string;
  authorship: string;
  itemDate: string;
  sourceIds: string[];
  title?: string;
  snippet?: string;
}

const ALL = 'all';
const NO_CATEGORY = 'none';

const KIND_LABELS: Record<string, string> = {
  email: 'Email',
  attachment: 'Attachment',
  file: 'File',
  note: 'Note',
};

const AUTHORSHIP_LABELS: Record<string, string> = {
  authored: 'Written by you',
  received: 'Received',
};

// Shared with the account page's deletion status view (same key, string literal).
function rememberDeletion(id: string) {
  try {
    const raw = sessionStorage.getItem('vs.pendingDeletions');
    const ids: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(ids) ? (ids as string[]) : [];
    if (!list.includes(id))
      sessionStorage.setItem('vs.pendingDeletions', JSON.stringify([...list, id]));
  } catch {
    // sessionStorage unavailable: the deletion still proceeds.
  }
}

function contentHref(f: { sourceId: string | null; query: string; cursor?: string }): string {
  const sp = new URLSearchParams();
  if (f.sourceId) sp.set('sourceId', f.sourceId);
  if (f.query.trim()) sp.set('query', f.query.trim());
  if (f.cursor) sp.set('cursor', f.cursor);
  const qs = sp.toString();
  return qs ? `/content?${qs}` : '/content';
}

export function ContentList({
  items,
  nextCursor,
  sources,
  categories,
  filters,
}: {
  items: ContentItem[];
  nextCursor: string | null;
  sources: { id: string; label: string }[];
  categories: { key: string; label: string }[];
  filters: { sourceId: string | null; query: string; paged: boolean };
}) {
  const router = useRouter();
  const [sourceId, setSourceId] = useState(filters.sourceId ?? ALL);
  const [query, setQuery] = useState(filters.query);
  const [reporting, setReporting] = useState<ContentItem | null>(null);
  const [category, setCategory] = useState(NO_CATEGORY);
  const [pending, setPending] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ContentItem | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    router.push(contentHref({ sourceId: sourceId === ALL ? null : sourceId, query }));
  }

  function openReport(item: ContentItem) {
    setReporting(item);
    setCategory(NO_CATEGORY);
    setReportError(null);
  }

  async function submitReport() {
    if (!reporting) return;
    setPending(true);
    setReportError(null);
    try {
      const res = await fetch(`/api/content-items/${reporting.id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(category === NO_CATEGORY ? {} : { category }),
      });
      if (!res.ok) {
        setReportError(
          res.status === 404 ? 'This item no longer exists.' : 'Could not report this item.',
        );
        return;
      }
      setReporting(null);
      toast.success('Removed and recorded');
      router.refresh();
    } catch {
      setReportError('Could not report this item.');
    } finally {
      setPending(false);
    }
  }

  async function submitDelete() {
    if (!deleting) return;
    const id = deleting.id;
    setPending(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/content-items/${id}`, { method: 'DELETE' });
      // 409: already being deleted, which is the state we want to show.
      if (!res.ok && res.status !== 409) {
        setDeleteError(
          res.status === 404 ? 'This item no longer exists.' : 'Could not delete this item.',
        );
        return;
      }
      if (res.ok) {
        const { deletionRequestId } = (await res.json()) as { deletionRequestId?: string };
        if (deletionRequestId) rememberDeletion(deletionRequestId);
      }
      setDeletingIds((prev) => new Set(prev).add(id));
      setDeleting(null);
      router.refresh();
    } catch {
      setDeleteError('Could not delete this item.');
    } finally {
      setPending(false);
    }
  }

  const sourceLabel = new Map(sources.map((s) => [s.id, s.label]));
  const filtered = filters.sourceId !== null || filters.query !== '';

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={applyFilters}
        className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-end sm:p-4"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="content-source">Source</Label>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger id="content-source" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {sources.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label htmlFor="content-query">Search</Label>
          <Input
            id="content-query"
            type="search"
            value={query}
            placeholder="Search your content"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit">Apply</Button>
          {filtered ? (
            <Button type="button" variant="ghost" onClick={() => router.push('/content')}>
              Clear
            </Button>
          ) : null}
        </div>
      </form>

      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filtered
            ? 'No content matches these filters.'
            : 'No content yet. Connect a mailbox or upload files.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary">{KIND_LABELS[item.kind] ?? item.kind}</Badge>
                  <Badge variant="outline">
                    {AUTHORSHIP_LABELS[item.authorship] ?? item.authorship}
                  </Badge>
                  <time className="text-muted-foreground" dateTime={item.itemDate}>
                    {new Date(item.itemDate).toLocaleDateString('en-GB')}
                  </time>
                </div>
                <p className="font-medium break-words">{item.title || 'Untitled'}</p>
                {item.snippet ? (
                  <p className="text-muted-foreground line-clamp-3 text-sm break-words">
                    {item.snippet}
                  </p>
                ) : null}
                {item.sourceIds.length > 0 ? (
                  <p className="text-muted-foreground text-xs break-all">
                    {item.sourceIds.map((id) => sourceLabel.get(id) ?? 'Removed source').join(', ')}
                  </p>
                ) : null}
              </div>
              {deletingIds.has(item.id) ? (
                <span className="text-muted-foreground self-start text-sm">Deleting...</span>
              ) : (
                <div className="flex flex-wrap gap-2 self-start">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openReport(item)}
                  >
                    Report as sensitive
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setDeleting(item);
                      setDeleteError(null);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {filters.paged || nextCursor ? (
        <nav aria-label="Pagination" className="flex flex-wrap justify-between gap-2">
          {filters.paged ? (
            <Button asChild variant="outline" size="sm">
              <Link href={contentHref({ sourceId: filters.sourceId, query: filters.query })}>
                First page
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={contentHref({
                  sourceId: filters.sourceId,
                  query: filters.query,
                  cursor: nextCursor,
                })}
              >
                Next page
              </Link>
            </Button>
          ) : null}
        </nav>
      ) : null}

      <Dialog
        open={reporting !== null}
        onOpenChange={(open) => (open ? undefined : setReporting(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report as sensitive</DialogTitle>
            <DialogDescription>
              This item will be removed from your content and memory store, and the miss is recorded
              so filters can improve. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="report-category">What kind of sensitive content? (optional)</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="report-category" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>Not sure / other</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {reportError ? (
              <p role="alert" className="text-destructive text-sm">
                {reportError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setReporting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void submitReport()}
            >
              {pending ? 'Removing...' : 'Remove and report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this item?</DialogTitle>
            <DialogDescription>
              This item will be removed from your content and memory store. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p role="alert" className="text-destructive text-sm">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void submitDelete()}
            >
              {pending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { DraftContentType } from '@voicespark/db';
import type { DraftListItem } from '@voicespark/core/services/drafts';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { KIND_PATH, SEARCH_TYPE_LABELS } from '@/components/hub/labels';
import { CONTENT_TYPE_LABELS, DraftStatusBadge, draftApiError } from './draft-status';

const ALL = 'all';

const RATING_LABELS = { sounds_like_me: 'Sounds like me', not_like_me: 'Not like me' } as const;

interface Filters {
  contentType: DraftContentType | null;
  profileId: string | null;
}

function draftsHref(f: Filters & { cursor?: string }): string {
  const sp = new URLSearchParams();
  if (f.contentType) sp.set('contentType', f.contentType);
  if (f.profileId) sp.set('profileId', f.profileId);
  if (f.cursor) sp.set('cursor', f.cursor);
  const qs = sp.toString();
  return qs ? `/drafts?${qs}` : '/drafts';
}

// Saved drafts (FR-054, FR-055); copy and export are the only ways to share a draft (FR-056).
export function DraftList({
  items,
  nextCursor,
  profiles,
  filters,
}: {
  items: DraftListItem[];
  nextCursor: string | null;
  profiles: { id: string; name: string }[];
  filters: Filters & { paged: boolean };
}) {
  const router = useRouter();
  const [contentType, setContentType] = useState<string>(filters.contentType ?? ALL);
  const [profileId, setProfileId] = useState<string>(filters.profileId ?? ALL);
  const [deleting, setDeleting] = useState<DraftListItem | null>(null);
  const [pending, setPending] = useState(false);

  const filtered = filters.contentType !== null || filters.profileId !== null;

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    router.push(
      draftsHref({
        contentType: contentType === ALL ? null : (contentType as DraftContentType),
        profileId: profileId === ALL ? null : profileId,
      }),
    );
  }

  async function copy(item: DraftListItem) {
    try {
      const res = await fetch(`/api/drafts/${item.id}`, { cache: 'no-store' });
      if (!res.ok) {
        toast.error(await draftApiError(res));
        return;
      }
      const draft = (await res.json()) as { title: string | null; text: string | null };
      if (draft.text === null) {
        toast.error('This draft is not ready yet.');
        return;
      }
      await navigator.clipboard.writeText(
        draft.title ? `${draft.title}\n\n${draft.text}` : draft.text,
      );
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy. Open the draft and copy the text instead.');
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setPending(true);
    try {
      const res = await fetch(`/api/drafts/${deleting.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        toast.error(await draftApiError(res));
        return;
      }
      setDeleting(null);
      toast.success('Draft deleted');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={applyFilters}
        className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-end sm:p-4"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="drafts-type">Content type</Label>
          <Select value={contentType} onValueChange={setContentType}>
            <SelectTrigger id="drafts-type" className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              {(Object.keys(CONTENT_TYPE_LABELS) as DraftContentType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {CONTENT_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="drafts-profile">Profile</Label>
          <Select value={profileId} onValueChange={setProfileId}>
            <SelectTrigger id="drafts-profile" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All profiles</SelectItem>
              {profiles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button type="submit">Apply</Button>
          {filtered ? (
            <Button type="button" variant="ghost" onClick={() => router.push('/drafts')}>
              Clear
            </Button>
          ) : null}
        </div>
      </form>

      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filtered ? 'No drafts match these filters.' : 'No drafts yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="draft-row"
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between sm:p-4"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="secondary">{CONTENT_TYPE_LABELS[item.contentType]}</Badge>
                  <DraftStatusBadge status={item.status} />
                  {item.rating ? (
                    <Badge variant="outline">{RATING_LABELS[item.rating]}</Badge>
                  ) : null}
                  <time className="text-muted-foreground" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleDateString('en-GB')}
                  </time>
                </div>
                <Link
                  href={`/drafts/${item.id}`}
                  className="block font-medium break-words underline-offset-4 hover:underline"
                >
                  {item.topic || 'Untitled draft'}
                </Link>
                <p className="text-muted-foreground text-xs">
                  {item.profile
                    ? `${item.profile.definitionName ?? 'Profile'}${
                        item.profileVersionNumber !== null
                          ? ` (version ${item.profileVersionNumber})`
                          : ''
                      }`
                    : 'Deleted profile'}
                </p>
                {item.hubRecord ? (
                  <p className="text-muted-foreground text-xs" data-testid="draft-hub-record">
                    {SEARCH_TYPE_LABELS[item.hubRecord.kind]}:{' '}
                    {item.hubRecord.id ? (
                      <Link
                        href={`/hub/${KIND_PATH[item.hubRecord.kind]}/${item.hubRecord.id}`}
                        className="text-foreground underline-offset-4 hover:underline"
                      >
                        {item.hubRecord.label}
                      </Link>
                    ) : (
                      <>{item.hubRecord.label} (removed)</>
                    )}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                {item.status === 'ready' ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copy(item)}
                    >
                      Copy
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/drafts/${item.id}/export?format=md`} download>
                        .md
                      </a>
                    </Button>
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/drafts/${item.id}/export?format=txt`} download>
                        .txt
                      </a>
                    </Button>
                  </>
                ) : null}
                <Button type="button" variant="ghost" size="sm" onClick={() => setDeleting(item)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {filters.paged || nextCursor ? (
        <nav aria-label="Pagination" className="flex flex-wrap justify-between gap-2">
          {filters.paged ? (
            <Button asChild variant="outline" size="sm">
              <Link href={draftsHref(filters)}>First page</Link>
            </Button>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Button asChild variant="outline" size="sm">
              <Link href={draftsHref({ ...filters, cursor: nextCursor })}>Next page</Link>
            </Button>
          ) : null}
        </nav>
      ) : null}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              The draft is removed permanently. Other drafts, including regenerated ones, are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void confirmDelete()}
            >
              {pending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

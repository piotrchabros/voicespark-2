'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { DraftRating } from '@voicespark/db';
import type { DraftView } from '@voicespark/core/services/drafts';
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
import { CONTENT_TYPE_LABELS, DraftStatus, draftApiError, isPending } from './draft-status';

const EDITED_TEXT_MAX = 20000;
const FEEDBACK_MAX = 2000;

const textareaClass = 'border-input bg-background w-full rounded-md border px-3 py-2 text-sm';

// Draft detail (FR-053, FR-055, FR-056): edit, rate, regenerate, copy, export and delete. There is no publish control.
export function DraftEditor({ draft }: { draft: DraftView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(draft.text ?? '');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState<null | 'save' | 'rate' | 'regenerate' | 'delete'>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const ready = draft.status === 'ready' && draft.text !== null;
  const canRegenerate = !isPending(draft.status) && draft.profile !== null;
  // A brief that was entirely filtered is not shown back.
  const showBrief = draft.errorCode !== 'brief_excluded';

  async function save() {
    if (!editedText.trim()) return;
    setPending('save');
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editedText }),
      });
      if (!res.ok) {
        toast.error(await draftApiError(res));
        return;
      }
      setEditing(false);
      toast.success('Draft saved');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(null);
    }
  }

  async function rate(rating: DraftRating) {
    setPending('rate');
    try {
      const res = await fetch(`/api/drafts/${draft.id}/rating`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      if (!res.ok) toast.error(await draftApiError(res));
      else router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(null);
    }
  }

  async function regenerate() {
    setPending('regenerate');
    try {
      const res = await fetch(`/api/drafts/${draft.id}/regenerate`, {
        method: 'POST',
        ...(feedback.trim()
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ feedback }),
            }
          : {}),
      });
      if (!res.ok) {
        toast.error(await draftApiError(res));
        return;
      }
      const { draftId } = (await res.json()) as { draftId: string };
      router.push(`/drafts/${draftId}`);
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    setPending('delete');
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        toast.error(await draftApiError(res));
        return;
      }
      setDeleteOpen(false);
      toast.success('Draft deleted');
      router.push('/drafts');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        draft.title ? `${draft.title}\n\n${draft.text ?? ''}` : (draft.text ?? ''),
      );
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy. Select the text and copy it instead.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          {CONTENT_TYPE_LABELS[draft.contentType]} ·{' '}
          {draft.profile
            ? `${draft.profile.definitionName ?? 'Profile'}${
                draft.profileVersionNumber !== null
                  ? ` (version ${draft.profileVersionNumber})`
                  : ''
              }`
            : 'Deleted profile'}{' '}
          ·{' '}
          <time dateTime={draft.createdAt}>
            {new Date(draft.createdAt).toLocaleString('en-GB')}
          </time>
        </p>
        <DraftStatus draftId={draft.id} status={draft.status} errorCode={draft.errorCode} />
        {draft.parentDraftId ? (
          <p className="text-sm">
            <Link href={`/drafts/${draft.parentDraftId}`} className="underline underline-offset-4">
              View the earlier draft
            </Link>
          </p>
        ) : null}
      </div>

      {showBrief ? (
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Your brief</summary>
          <p className="mt-2 break-words whitespace-pre-wrap">{draft.brief}</p>
          {draft.feedback ? (
            <>
              <p className="mt-3 font-medium">Your feedback</p>
              <p className="mt-1 break-words whitespace-pre-wrap">{draft.feedback}</p>
            </>
          ) : null}
        </details>
      ) : null}

      {draft.redactionsApplied > 0 ? (
        <p role="note" className="bg-muted rounded-md p-3 text-sm">
          Some details were removed because they match your filters.
        </p>
      ) : null}
      {draft.truncated ? (
        <p role="note" className="bg-muted rounded-md p-3 text-sm">
          This draft was shortened to fit the length limit for a{' '}
          {CONTENT_TYPE_LABELS[draft.contentType].toLowerCase()}.
        </p>
      ) : null}

      {ready ? (
        <section className="flex flex-col gap-3">
          {draft.title ? (
            <h2 data-testid="draft-title" className="text-xl font-semibold break-words">
              {draft.title}
            </h2>
          ) : null}
          {editing ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="draft-edit">Edit the draft</Label>
              <textarea
                id="draft-edit"
                value={editedText}
                maxLength={EDITED_TEXT_MAX}
                rows={14}
                onChange={(e) => setEditedText(e.target.value)}
                className={textareaClass}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={pending !== null || !editedText.trim()}
                  onClick={() => void save()}
                >
                  {pending === 'save' ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditedText(draft.text ?? '');
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div
              data-testid="draft-body"
              className="rounded-lg border p-3 text-sm leading-relaxed break-words whitespace-pre-wrap sm:p-4"
            >
              {draft.text}
            </div>
          )}
          {draft.editedText !== null && !editing ? (
            <p className="text-muted-foreground text-xs">You edited this draft.</p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {!editing ? (
              <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => void copy()}>
              Copy
            </Button>
            <Button asChild variant="outline">
              <a href={`/api/drafts/${draft.id}/export?format=md`} download data-testid="export-md">
                Export .md
              </a>
            </Button>
            <Button asChild variant="outline">
              <a
                href={`/api/drafts/${draft.id}/export?format=txt`}
                download
                data-testid="export-txt"
              >
                Export .txt
              </a>
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Does this sound like you?</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-testid="rating-sounds-like-me"
                variant={draft.rating === 'sounds_like_me' ? 'default' : 'outline'}
                disabled={pending !== null}
                aria-pressed={draft.rating === 'sounds_like_me'}
                onClick={() => void rate('sounds_like_me')}
              >
                Sounds like me
              </Button>
              <Button
                type="button"
                data-testid="rating-not-like-me"
                variant={draft.rating === 'not_like_me' ? 'default' : 'outline'}
                disabled={pending !== null}
                aria-pressed={draft.rating === 'not_like_me'}
                onClick={() => void rate('not_like_me')}
              >
                Not like me
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {canRegenerate ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void regenerate();
          }}
        >
          <Label htmlFor="draft-feedback">What should change? (optional)</Label>
          <textarea
            id="draft-feedback"
            value={feedback}
            maxLength={FEEDBACK_MAX}
            rows={3}
            onChange={(e) => setFeedback(e.target.value)}
            className={textareaClass}
          />
          <p className="text-muted-foreground text-xs">
            A new draft is written; this one stays in your list.
          </p>
          <Button
            type="submit"
            variant="outline"
            disabled={pending !== null}
            className="sm:self-start"
          >
            {pending === 'regenerate'
              ? 'Requesting...'
              : feedback.trim()
                ? 'Regenerate with feedback'
                : 'Regenerate'}
          </Button>
        </form>
      ) : null}

      <div className="border-t pt-4">
        <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)}>
          Delete draft
        </Button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              The draft is removed permanently. Other drafts, including regenerated ones, are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending !== null}
              onClick={() => void remove()}
            >
              {pending === 'delete' ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

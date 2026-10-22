'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DraftContentType, DraftStatus as Status } from '@voicespark/db';
import { Badge } from '@/components/ui/badge';

export const CONTENT_TYPE_LABELS: Record<DraftContentType, string> = {
  social_post: 'Social post',
  bio: 'Bio',
  short_article: 'Short article',
};

const STATUS_LABELS: Record<Status, string> = {
  queued: 'Queued',
  generating: 'Writing',
  ready: 'Ready',
  failed: 'Failed',
};

// Plain-words reasons for a failed draft; never repeats the brief or any filtered value.
const ERROR_TEXT: Record<string, string> = {
  brief_excluded:
    'Your brief only contained filtered information, so there was nothing left to write about. Try a brief without it.',
  profile_excluded:
    'The profile only contained filtered information, so it could not be used. Regenerate the profile and try again.',
  profile_deleted:
    'The profile for this draft was deleted. Choose another profile for a new draft.',
  output_excluded:
    'The draft only contained filtered information, so it was not saved. Try a different brief.',
  llm_refused: 'The writing assistant declined this brief. Try rewording it.',
  generation_failed: 'Something went wrong while writing this draft. Try again later.',
  user_inactive: 'Your account is not active, so the draft was stopped.',
};

export function draftErrorText(errorCode: string | null): string {
  return ERROR_TEXT[errorCode ?? ''] ?? 'This draft could not be written. Try again later.';
}

export const isPending = (status: Status) => status === 'queued' || status === 'generating';

/** User-facing message for a failed drafts API call; 429 is the shared create/regenerate limit. */
export async function draftApiError(res: Response): Promise<string> {
  if (res.status === 429)
    return 'You have requested many drafts in a short time. Wait a minute and try again.';
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code === 'no_profile')
      return 'This profile has no version. Generate a profile first.';
    if (body.error?.code === 'not_found') return 'This draft no longer exists.';
    if (body.error?.code === 'conflict') return 'This draft is not ready yet.';
    return body.error?.message ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

export function DraftStatusBadge({ status }: { status: Status }) {
  return (
    <Badge
      variant={status === 'failed' ? 'destructive' : status === 'ready' ? 'secondary' : 'outline'}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}

// Polls the draft every 2 s while it is queued or writing, then refreshes the page once it settles.
export function DraftStatus({
  draftId,
  status: initialStatus,
  errorCode: initialErrorCode,
}: {
  draftId: string;
  status: Status;
  errorCode: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [errorCode, setErrorCode] = useState(initialErrorCode);
  const [unavailable, setUnavailable] = useState(false);
  const routerRef = useRef(router);

  useEffect(() => {
    routerRef.current = router;
  });

  useEffect(() => {
    if (!isPending(initialStatus)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/drafts/${draftId}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('draft_status_failed');
        const data = (await res.json()) as { status: Status; errorCode: string | null };
        if (cancelled) return;
        setStatus(data.status);
        setErrorCode(data.errorCode);
        if (isPending(data.status)) timer = setTimeout(poll, 2000);
        else routerRef.current.refresh();
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [draftId, initialStatus]);

  let text: string;
  if (unavailable) text = 'The draft status is unavailable. Reload the page to try again.';
  else if (status === 'queued') text = 'Queued...';
  else if (status === 'generating') text = 'Writing your draft...';
  else if (status === 'ready') text = 'Draft ready.';
  else text = draftErrorText(errorCode);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DraftStatusBadge status={status} />
      <p
        role="status"
        data-testid="draft-status"
        data-status={status}
        className={
          status === 'failed' ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'
        }
      >
        {text}
      </p>
    </div>
  );
}

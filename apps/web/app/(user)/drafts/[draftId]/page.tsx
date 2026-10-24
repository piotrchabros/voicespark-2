import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import * as drafts from '@voicespark/core/services/drafts';
import { DraftEditor } from '@/components/drafts/draft-editor';
import { KIND_PATH, SEARCH_TYPE_LABELS } from '@/components/hub/labels';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/** Why a pinned record's details were not used (FR-027); `used` and no pin say nothing. */
const CONTEXT_NOTICE: Partial<Record<NonNullable<drafts.DraftView['hubContextStatus']>, string>> = {
  missing: 'The record was removed before the draft was written, so its details were not used.',
  inspection_failed: "The record's details could not be checked, so they were not used.",
};

export default async function DraftDetailPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const ctx = await requireUserOrRedirect();
  const { draftId } = await params;

  let draft: Awaited<ReturnType<typeof drafts.get>>;
  try {
    draft = await drafts.get(ctx, draftId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="space-y-2">
        <Link
          href="/drafts"
          className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          Back to drafts
        </Link>
        <h1 className="text-2xl font-semibold">Draft</h1>
        {draft.hubRecord ? (
          <p className="text-muted-foreground text-sm" data-testid="draft-hub-record">
            About {SEARCH_TYPE_LABELS[draft.hubRecord.kind].toLowerCase()}:{' '}
            {draft.hubRecord.id ? (
              <Link
                href={`/hub/${KIND_PATH[draft.hubRecord.kind]}/${draft.hubRecord.id}`}
                className="text-foreground underline underline-offset-4"
              >
                {draft.hubRecord.label}
              </Link>
            ) : (
              <>{draft.hubRecord.label} (removed)</>
            )}
          </p>
        ) : null}
        {draft.hubContextStatus && CONTEXT_NOTICE[draft.hubContextStatus] ? (
          <p className="text-muted-foreground text-xs">{CONTEXT_NOTICE[draft.hubContextStatus]}</p>
        ) : null}
      </div>
      {/* Remount on status/edit changes so local edit state follows the refreshed draft. */}
      <DraftEditor
        key={`${draft.id}:${draft.status}:${draft.editedText?.length ?? -1}:${draft.rating ?? ''}`}
        draft={draft}
      />
    </div>
  );
}

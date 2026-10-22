import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import * as drafts from '@voicespark/core/services/drafts';
import { DraftEditor } from '@/components/drafts/draft-editor';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

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
      </div>
      {/* Remount on status/edit changes so local edit state follows the refreshed draft. */}
      <DraftEditor
        key={`${draft.id}:${draft.status}:${draft.editedText?.length ?? -1}:${draft.rating ?? ''}`}
        draft={draft}
      />
    </div>
  );
}

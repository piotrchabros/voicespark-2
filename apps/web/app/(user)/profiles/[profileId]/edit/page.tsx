import { notFound, redirect } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import * as profiles from '@voicespark/core/services/profiles';
import { DocumentEditor } from '@/components/profiles/document-editor';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function EditProfileDocumentPage({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const ctx = await requireUserOrRedirect();
  const { profileId } = await params;

  let data: Awaited<ReturnType<typeof profiles.get>>;
  try {
    data = await profiles.get(ctx, profileId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }

  const latest = data.latestVersion;
  if (!latest || latest.format !== 'document') redirect(`/profiles/${profileId}`);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Edit profile</h1>
      <p className="text-muted-foreground text-sm">
        Saving creates a new version from version {latest.versionNumber}.
      </p>
      <DocumentEditor profileId={profileId} baseVersionId={latest.id} document={latest.body} />
    </div>
  );
}

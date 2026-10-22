import { redirect } from 'next/navigation';
import * as filterPreferences from '@voicespark/core/services/filter-preferences';
import { loadEnv } from '@voicespark/core/env';
import * as uploads from '@voicespark/core/services/uploads';
import { NoteForm } from '@/components/uploads/note-form';
import { UploadDropzone } from '@/components/uploads/upload-dropzone';
import { UploadList } from '@/components/uploads/upload-list';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function UploadsPage() {
  const ctx = await requireUserOrRedirect();
  // FR-061: nothing can be added before the exclusion filters are confirmed.
  const prefs = await filterPreferences.get(ctx);
  if (prefs.confirmedAt === null) redirect('/onboarding/filters?returnTo=/uploads');

  const { items } = await uploads.list(ctx, { limit: 50 });
  const maxMb = Math.floor(loadEnv().UPLOAD_MAX_BYTES / (1024 * 1024));

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold">Uploads and notes</h1>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Upload files</h2>
        <UploadDropzone maxMb={maxMb} />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Write a note</h2>
        <NoteForm />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Your items</h2>
        <UploadList initial={items} />
      </section>
    </div>
  );
}

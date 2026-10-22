import Link from 'next/link';
import { redirect } from 'next/navigation';
import * as profiles from '@voicespark/core/services/profiles';
import { DraftForm } from '@/components/drafts/draft-form';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function NewDraftPage({
  searchParams,
}: {
  searchParams: Promise<{ profileId?: string | string[] }>;
}) {
  const ctx = await requireUserOrRedirect();
  const { profileId: rawProfileId } = await searchParams;
  const usable = (await profiles.list(ctx)).filter(
    (p) => p.status === 'active' && p.latestVersion !== null,
  );
  // No generated profile: the drafts page shows the "Generate a profile first" guidance (FR-052).
  if (usable.length === 0) redirect('/drafts');

  const options = usable.map((p) => ({ id: p.id, name: p.definition.name }));
  const wanted = Array.isArray(rawProfileId) ? rawProfileId[0] : rawProfileId;
  const initialProfileId = options.some((p) => p.id === wanted) ? (wanted ?? null) : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="space-y-2">
        <Link
          href="/drafts"
          className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          Back to drafts
        </Link>
        <h1 className="text-2xl font-semibold">New draft</h1>
        <p className="text-muted-foreground text-sm">
          Pick what to write and which profile's voice to use, then describe the topic.
        </p>
      </div>
      <DraftForm profiles={options} initialProfileId={initialProfileId} />
    </div>
  );
}

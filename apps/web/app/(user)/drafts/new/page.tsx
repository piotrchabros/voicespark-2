import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import * as hubRecords from '@voicespark/core/services/hub/records';
import * as profiles from '@voicespark/core/services/profiles';
import { DraftForm } from '@/components/drafts/draft-form';
import type { PickedRecord } from '@/components/hub/record-picker';
import type { ServiceKind } from '@/components/hub/labels';
import type { UserContext } from '@/lib/guards';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

const RECORD_KINDS: readonly ServiceKind[] = ['person', 'company', 'project'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `?recordKind=&recordId=` preselects one of the user's own records (FR-027); anything else is ignored. */
async function initialRecord(
  ctx: UserContext,
  kind: string | undefined,
  id: string | undefined,
): Promise<PickedRecord | null> {
  if (!kind || !id || !RECORD_KINDS.includes(kind as ServiceKind) || !UUID_RE.test(id)) return null;
  try {
    const { record } = await hubRecords.get(ctx, kind as ServiceKind, id);
    return { kind: kind as ServiceKind, id: record.id, name: record.name };
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') return null;
    throw err;
  }
}

export default async function NewDraftPage({
  searchParams,
}: {
  searchParams: Promise<{
    profileId?: string | string[];
    recordKind?: string | string[];
    recordId?: string | string[];
  }>;
}) {
  const ctx = await requireUserOrRedirect();
  const { profileId: rawProfileId, recordKind, recordId } = await searchParams;
  const usable = (await profiles.list(ctx)).filter(
    (p) => p.status === 'active' && p.latestVersion !== null,
  );
  // No generated profile: the drafts page shows the "Generate a profile first" guidance (FR-052).
  if (usable.length === 0) redirect('/drafts');

  const options = usable.map((p) => ({ id: p.id, name: p.definition.name }));
  const wanted = first(rawProfileId);
  const initialProfileId = options.some((p) => p.id === wanted) ? (wanted ?? null) : null;
  const record = await initialRecord(ctx, first(recordKind), first(recordId));

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
          Pick what to write and which profile's voice to use, then describe the topic. You can also pick a person,
          company or project from your hub as background.
        </p>
      </div>
      <DraftForm profiles={options} initialProfileId={initialProfileId} initialRecord={record} />
    </div>
  );
}

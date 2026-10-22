import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DRAFT_CONTENT_TYPES, type DraftContentType } from '@voicespark/db';
import { AppError } from '@voicespark/core/errors';
import * as drafts from '@voicespark/core/services/drafts';
import * as profiles from '@voicespark/core/services/profiles';
import { DraftList } from '@/components/drafts/draft-list';
import { Button } from '@/components/ui/button';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

const isContentType = (v: string | undefined): v is DraftContentType =>
  v !== undefined && (DRAFT_CONTENT_TYPES as readonly string[]).includes(v);

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{
    contentType?: string | string[];
    profileId?: string | string[];
    cursor?: string | string[];
  }>;
}) {
  const ctx = await requireUserOrRedirect();
  const params = await searchParams;
  const rawType = first(params.contentType);
  const contentType = isContentType(rawType) ? rawType : undefined;
  const profileId = first(params.profileId);
  const cursor = first(params.cursor);

  let page: Awaited<ReturnType<typeof drafts.list>>;
  try {
    page = await drafts.list(ctx, {
      limit: PAGE_SIZE,
      ...(contentType ? { contentType } : {}),
      ...(profileId ? { profileId } : {}),
      ...(cursor ? { cursor } : {}),
    });
  } catch (err) {
    // A stale or tampered cursor restarts from the first page.
    if (err instanceof AppError && err.code === 'validation_failed') redirect('/drafts');
    throw err;
  }
  const profileList = (await profiles.list(ctx)).filter((p) => p.status === 'active');
  // Drafting needs a profile with at least one version (FR-052).
  const canDraft = profileList.some((p) => p.latestVersion !== null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Drafts</h1>
          <p className="text-muted-foreground text-sm">
            Social posts, bios and short articles written in your voice. Copy or export a draft to
            use it anywhere.
          </p>
        </div>
        {canDraft ? (
          <Button asChild className="sm:self-start">
            <Link href="/drafts/new">New draft</Link>
          </Button>
        ) : null}
      </div>

      {!canDraft ? (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <p className="font-medium">Generate a profile first</p>
          <p className="text-muted-foreground text-sm">
            Drafts are written in the voice of one of your profiles. Generate a profile, then come
            back to request a draft.
          </p>
          <Button asChild variant="outline" className="sm:self-start">
            <Link href="/profiles">Go to profiles</Link>
          </Button>
        </div>
      ) : null}

      {canDraft || page.items.length > 0 || cursor !== undefined ? (
        <DraftList
          items={page.items}
          nextCursor={page.nextCursor}
          profiles={profileList.map((p) => ({ id: p.id, name: p.definition.name }))}
          filters={{
            contentType: contentType ?? null,
            profileId: profileId ?? null,
            paged: cursor !== undefined,
          }}
        />
      ) : null}
    </div>
  );
}

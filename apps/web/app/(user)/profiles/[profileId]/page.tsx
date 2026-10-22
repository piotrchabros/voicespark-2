import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import * as definitions from '@voicespark/core/services/definitions';
import * as profiles from '@voicespark/core/services/profiles';
import { AdjustForm, type AdjustDimension } from '@/components/profiles/adjust-form';
import { FeedbackForm } from '@/components/profiles/feedback-form';
import { ProfileBodyView } from '@/components/profiles/profile-body';
import { RatingButtons } from '@/components/profiles/rating-buttons';
import { VersionHistory } from '@/components/profiles/version-history';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function ProfileDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ profileId: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const ctx = await requireUserOrRedirect();
  const { profileId } = await params;
  const { version: versionParam } = await searchParams;

  let data: Awaited<ReturnType<typeof profiles.get>>;
  let history: Awaited<ReturnType<typeof profiles.versions>>;
  let selected: Awaited<ReturnType<typeof profiles.version>> | null;
  try {
    data = await profiles.get(ctx, profileId);
    history = await profiles.versions(ctx, profileId);
    selected =
      versionParam && versionParam !== data.latestVersion?.id
        ? await profiles.version(ctx, profileId, versionParam)
        : data.latestVersion;
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }

  const { profile, latestVersion } = data;
  const isLatest = selected !== null && selected.id === latestVersion?.id;

  // Dimension specs come from the pinned definition version (names, value types, scale, options).
  const specs = latestVersion
    ? ((await definitions.getVersionForGeneration(latestVersion.definitionVersion.id))
        ?.dimensions ?? [])
    : [];
  const selectedSpecs =
    selected &&
    latestVersion &&
    selected.definitionVersion.id !== latestVersion.definitionVersion.id
      ? ((await definitions.getVersionForGeneration(selected.definitionVersion.id))?.dimensions ??
        [])
      : specs;
  const labels = selectedSpecs.map((d) => ({ key: d.key, name: d.name }));
  const adjustDims: AdjustDimension[] = specs.map((d) => ({
    key: d.key,
    name: d.name,
    valueType: d.valueType,
    ...(d.scale ? { scale: d.scale } : {}),
    ...(d.allowedValues ? { allowedValues: d.allowedValues } : {}),
    value: latestVersion?.body.dimensions.find((x) => x.key === d.key)?.value ?? null,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/profiles" className="text-sm underline">
          All profiles
        </Link>
        <h1 className="text-2xl font-semibold break-words">{profile.definition.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {profile.outdatedReason ? <Badge variant="destructive">Outdated</Badge> : null}
          {profile.definition.retired ? (
            <Badge variant="secondary">Definition retired</Badge>
          ) : null}
          {profile.activeGeneration ? <Badge variant="outline">Generating</Badge> : null}
        </div>
      </div>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Version {selected.versionNumber}
              {isLatest ? ' (latest)' : ''}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Definition v{selected.definitionVersion.versionNumber}
              {selected.promptVersion ? `, prompt v${selected.promptVersion.versionNumber}` : ''},
              created {new Date(selected.createdAt).toLocaleString()}
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ProfileBodyView body={selected.body} labels={labels} />
            <RatingButtons
              profileId={profile.id}
              versionId={selected.id}
              rating={selected.rating}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No version has been generated yet.
          </CardContent>
        </Card>
      )}

      {latestVersion ? (
        <Card>
          <CardHeader>
            <CardTitle>Regenerate</CardTitle>
          </CardHeader>
          <CardContent>
            <FeedbackForm profileId={profile.id} canRegenerate={profile.canRegenerate} />
          </CardContent>
        </Card>
      ) : null}

      {latestVersion && adjustDims.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Adjust manually</CardTitle>
            <p className="text-sm text-muted-foreground">
              Adjustments are applied to the latest version and saved as a new version.
            </p>
          </CardHeader>
          <CardContent>
            <AdjustForm key={latestVersion.id} profileId={profile.id} dimensions={adjustDims} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Version history</CardTitle>
        </CardHeader>
        <CardContent>
          <VersionHistory profileId={profile.id} items={history} selectedId={selected?.id ?? ''} />
        </CardContent>
      </Card>
    </div>
  );
}

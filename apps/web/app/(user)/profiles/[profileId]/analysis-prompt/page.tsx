import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import * as ownPrompts from '@voicespark/core/services/own-prompts';
import * as profiles from '@voicespark/core/services/profiles';
import { AnalysisPromptEditor } from '@/components/profiles/analysis-prompt-editor';
import { DefaultChangedBanner } from '@/components/profiles/default-changed-banner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TextDiff } from '@/components/ui/text-diff';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function AnalysisPromptPage({
  params,
  searchParams,
}: {
  params: Promise<{ profileId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requireUserOrRedirect();
  const { profileId } = await params;
  const { from, to } = await searchParams;

  let definitionId: string;
  let detail: Awaited<ReturnType<typeof ownPrompts.get>>;
  let versions: Awaited<ReturnType<typeof ownPrompts.listVersions>>;
  let changes: Awaited<ReturnType<typeof ownPrompts.defaultChanges>> | null = null;
  try {
    const { profile } = await profiles.get(ctx, profileId);
    definitionId = profile.definition.id;
    detail = await ownPrompts.get(ctx, definitionId);
    versions = await ownPrompts.listVersions(ctx, definitionId);
    if (from) changes = await ownPrompts.defaultChanges(ctx, definitionId, from, to);
  } catch (err) {
    if (err instanceof AppError && (err.code === 'not_found' || err.code === 'validation_failed'))
      notFound();
    throw err;
  }

  const inUse = detail.own?.inUse === true;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href={`/profiles/${profileId}`} className="text-sm underline">
          Back to profile
        </Link>
        <h1 className="text-2xl font-semibold break-words">
          Analysis prompt: {detail.definition.name}
        </h1>
      </div>

      {changes ? (
        <Card>
          <CardHeader>
            <CardTitle>
              What changed in the default (v{changes.from.versionNumber} to v
              {changes.to.versionNumber})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <TextDiff ops={changes.diff} label="Changes between default versions" />
            {inUse ? (
              <DefaultChangedBanner
                profileId={profileId}
                definitionId={definitionId}
                fromDefinitionVersionId={changes.from.id}
                toDefinitionVersionId={changes.to.id}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <AnalysisPromptEditor
            key={detail.own?.currentVersion?.id ?? `default-${String(inUse)}`}
            definitionId={definitionId}
            detail={detail}
            versions={versions}
          />
        </CardContent>
      </Card>
    </div>
  );
}

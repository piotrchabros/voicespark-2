import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as definitions from '@voicespark/core/services/definitions';
import { AnalysisPreview } from '@/components/admin/analysis-preview';
import { AvailabilityToggle, DraftVersionForm } from '@/components/admin/definition-forms';
import { DimensionList } from '@/components/admin/dimension-editor';
import { Forbidden } from '@/components/admin/forbidden';
import { VersionPanel } from '@/components/admin/version-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/format';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

type Version = Awaited<ReturnType<typeof definitions.adminGet>>['versions'][number];

/** The version's analysis prompt, plus the read-only dimensions of legacy versions. */
function VersionContent({ version }: { version: Version }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Analysis prompt</h3>
        {version.analysisPrompt ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-xs">
            {version.analysisPrompt}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No analysis prompt.</p>
        )}
      </div>
      {version.dimensions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Dimensions (legacy, read-only)</h3>
          <DimensionList dimensions={version.dimensions} />
        </div>
      ) : null}
    </div>
  );
}

export default async function AdminDefinitionDetailPage({
  params,
}: {
  params: Promise<{ definitionId: string }>;
}) {
  const admin = await requireAdminPage();
  if (!admin) return <Forbidden />;
  const { definitionId } = await params;
  if (!z.uuid().safeParse(definitionId).success) notFound();

  let data: Awaited<ReturnType<typeof definitions.adminGet>>;
  try {
    data = await definitions.adminGet(definitionId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }
  const { definition, versions } = data;
  const draft = versions.find((v) => v.status === 'draft');
  const active = versions.find((v) => v.status === 'active');
  const superseded = versions.filter((v) => v.status === 'superseded');
  const previewTarget = draft ?? active;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/admin/definitions" className="text-sm underline">
          All definitions
        </Link>
        <h1 className="text-2xl font-semibold break-all">
          {active?.name ?? draft?.name ?? definition.key}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={definition.availability === 'available' ? 'default' : 'outline'}>
            {definition.availability}
          </Badge>
          <span className="text-muted-foreground break-all">
            {definition.key} - chosen by {definition.userChoiceCount}{' '}
            {definition.userChoiceCount === 1 ? 'user' : 'users'}, own prompt in use by{' '}
            {definition.ownPromptCount} {definition.ownPromptCount === 1 ? 'user' : 'users'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <AvailabilityToggle
            definitionId={definition.id}
            availability={definition.availability}
            hasActiveVersion={definition.activeVersion !== null}
          />
        </div>
      </div>

      {draft ? (
        <Card>
          <CardHeader>
            <CardTitle>Draft version {draft.versionNumber}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DraftVersionForm key={draft.id} definitionId={definition.id} draft={draft} />
            {draft.dimensions.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">Dimensions (legacy, read-only)</h3>
                <DimensionList dimensions={draft.dimensions} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {active ? (
        <Card>
          <CardHeader>
            <CardTitle>Active version {active.versionNumber}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">{active.description}</p>
            <p className="text-sm text-muted-foreground">
              Published {formatTime(active.publishedAt)}
            </p>
            <VersionContent version={active} />
          </CardContent>
        </Card>
      ) : null}

      {previewTarget ? (
        <Card>
          <CardHeader>
            <CardTitle>Preview version {previewTarget.versionNumber}</CardTitle>
          </CardHeader>
          <CardContent>
            <AnalysisPreview
              key={previewTarget.id}
              definitionId={definition.id}
              versionId={previewTarget.id}
            />
          </CardContent>
        </Card>
      ) : null}

      {superseded.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Earlier versions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {superseded.map((v) => (
              <details key={v.id} className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Version {v.versionNumber}: {v.name}
                  <span className="font-normal text-muted-foreground">
                    {' '}
                    - published {formatTime(v.publishedAt)}
                  </span>
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-sm">{v.description}</p>
                  <VersionContent version={v} />
                </div>
              </details>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Versions and history</CardTitle>
        </CardHeader>
        <CardContent>
          <VersionPanel
            kind="definitions"
            entityId={definition.id}
            versions={versions.map((v) => ({
              id: v.id,
              versionNumber: v.versionNumber,
              status: v.status,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}

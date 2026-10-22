import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AppError } from '@voicespark/core/errors';
import * as definitions from '@voicespark/core/services/definitions';
import { AvailabilityToggle } from '@/components/admin/definition-forms';
import { DimensionEditor } from '@/components/admin/dimension-editor';
import { Forbidden } from '@/components/admin/forbidden';
import { formatTime, VersionPanel } from '@/components/admin/version-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

type Version = Awaited<ReturnType<typeof definitions.adminGet>>['versions'][number];

function DimensionList({ version }: { version: Version }) {
  return (
    <ul className="flex flex-col gap-3 text-sm">
      {version.dimensions.map((d) => (
        <li key={d.key} className="flex flex-col gap-1 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.name}</span>
            <code className="text-muted-foreground">{d.key}</code>
            <Badge variant="outline">{d.valueType}</Badge>
          </div>
          <p>{d.description}</p>
          {d.scale ? (
            <p className="text-muted-foreground">
              {d.scale.min} ({d.scale.minLabel || 'min'}) to {d.scale.max} (
              {d.scale.maxLabel || 'max'})
            </p>
          ) : null}
          {d.allowedValues && d.allowedValues.length > 0 ? (
            <p className="text-muted-foreground">Allowed: {d.allowedValues.join(', ')}</p>
          ) : null}
          {d.guidance ? <p className="text-muted-foreground">Guidance: {d.guidance}</p> : null}
        </li>
      ))}
    </ul>
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
            {definition.userChoiceCount === 1 ? 'user' : 'users'}
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
          <CardContent>
            <DimensionEditor key={draft.id} definitionId={definition.id} draft={draft} />
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
            <DimensionList version={active} />
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

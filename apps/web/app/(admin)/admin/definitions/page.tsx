import Link from 'next/link';
import * as definitions from '@voicespark/core/services/definitions';
import { AvailabilityToggle, NewDefinitionForm } from '@/components/admin/definition-forms';
import { Forbidden } from '@/components/admin/forbidden';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function AdminDefinitionsPage() {
  const admin = await requireAdminPage();
  if (!admin) return <Forbidden />;
  const items = await definitions.adminList();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Tone definitions</h1>
        <p className="text-sm text-muted-foreground">
          Users choose from available definitions. At least one definition must stay available.
        </p>
      </div>

      <NewDefinitionForm />

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No definitions yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((d) => (
            <li key={d.id}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 break-all">
                    <Link href={`/admin/definitions/${d.id}`} className="underline">
                      {d.activeVersion?.name ?? d.key}
                    </Link>
                    <Badge variant={d.availability === 'available' ? 'default' : 'outline'}>
                      {d.availability}
                    </Badge>
                    {d.draftVersionId ? <Badge variant="secondary">draft pending</Badge> : null}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">Key</dt>
                    <dd className="break-all">{d.key}</dd>
                    <dt className="text-muted-foreground">Active version</dt>
                    <dd>
                      {d.activeVersion
                        ? `Version ${d.activeVersion.versionNumber}`
                        : 'None published'}
                    </dd>
                    <dt className="text-muted-foreground">Chosen by</dt>
                    <dd>
                      {d.userChoiceCount} {d.userChoiceCount === 1 ? 'user' : 'users'}
                    </dd>
                    <dt className="text-muted-foreground">Own prompt in use</dt>
                    <dd>
                      {d.ownPromptCount} {d.ownPromptCount === 1 ? 'user' : 'users'}
                    </dd>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <AvailabilityToggle
                      definitionId={d.id}
                      availability={d.availability}
                      hasActiveVersion={d.activeVersion !== null}
                    />
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

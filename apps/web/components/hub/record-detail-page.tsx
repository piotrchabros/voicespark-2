import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import { get } from '@voicespark/core/services/hub/records';
import { requireUserOrRedirect } from '@/lib/page-auth';
import { Badge } from '@/components/ui/badge';
import { RecordDetailActions } from './record-detail-actions';
import { KIND_LABELS, STATUS_LABELS, type HubKind, type HubRecord } from './labels';

const SERVICE_KIND = { people: 'person', companies: 'company', projects: 'project' } as const;
const KIND_PATH = { person: 'people', company: 'companies', project: 'projects' } as const;

const SYNC_LABELS: Record<string, string> = {
  pending: 'Waiting to sync',
  synced: 'Synced',
  failed: 'Sync failed',
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// Shared by the three detail pages; links, notes, files, summaries and sources are added to this screen by US2, US3, US7.
export async function RecordDetailPage({ kind, id }: { kind: HubKind; id: string }) {
  const ctx = await requireUserOrRedirect();
  let data: Awaited<ReturnType<typeof get>>;
  try {
    data = await get(ctx, SERVICE_KIND[kind], id);
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') notFound();
    throw err;
  }
  const { record, links, sync } = data;
  const r = record as HubRecord;

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <Link href={`/hub/${kind}`} className="text-muted-foreground text-sm underline">
          {KIND_LABELS[kind].plural}
        </Link>
        <h1 className="text-2xl font-semibold">{r.name}</h1>
        <div className="flex flex-wrap gap-2">
          {kind === 'projects' && r.status ? (
            <Badge variant="outline">{STATUS_LABELS[r.status]}</Badge>
          ) : null}
          <Badge variant="secondary">
            {r.createdFrom === 'email' ? 'Created from email' : 'Created by you'}
          </Badge>
          <Badge variant="secondary">{SYNC_LABELS[sync.status] ?? sync.status}</Badge>
        </div>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        {kind === 'people' ? (
          <>
            <Field label="Role" value={r.roleTitle} />
            <Field label="Phone" value={r.phone} />
          </>
        ) : null}
        {kind === 'companies' ? (
          <>
            <Field label="Website" value={r.website} />
            <Field label="Industry" value={r.industry} />
          </>
        ) : null}
        {kind === 'projects' ? (
          <>
            <Field label="Start date" value={r.startDate} />
            <Field label="End date" value={r.endDate} />
          </>
        ) : null}
        <Field label="Description" value={r.description} />
      </dl>

      {r.emails && r.emails.length > 0 ? (
        <section aria-label="Email addresses" className="space-y-1">
          <p className="text-muted-foreground text-sm">Email addresses</p>
          <ul>
            {r.emails.map((e) => (
              <li key={e.id}>
                {e.address}
                {e.isPrimary ? ' (primary)' : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.domains && r.domains.length > 0 ? (
        <section aria-label="Domains" className="space-y-1">
          <p className="text-muted-foreground text-sm">Domains</p>
          <ul>
            {r.domains.map((d) => (
              <li key={d.id}>{d.domain}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Linked records" className="space-y-1">
        <p className="text-muted-foreground text-sm">Links</p>
        {links.length === 0 ? (
          <p className="text-sm">No links yet.</p>
        ) : (
          <ul>
            {links.map(({ link, other }) => (
              <li key={link.id}>
                <Link
                  href={`/hub/${KIND_PATH[other.kind]}/${other.id}`}
                  className="underline underline-offset-4"
                >
                  {other.name}
                </Link>
                {link.role ? ` (${link.role})` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <RecordDetailActions kind={kind} record={r} />
    </div>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppError } from '@voicespark/core/errors';
import { list as listFiles } from '@voicespark/core/services/hub/files';
import { list as listNotes } from '@voicespark/core/services/hub/notes';
import { get } from '@voicespark/core/services/hub/records';
import { sourcesForRecord } from '@voicespark/core/services/hub/sources';
import { requireUserOrRedirect } from '@/lib/page-auth';
import { Badge } from '@/components/ui/badge';
import { FileList } from './file-list';
import { FileUpload } from './file-upload';
import { LinkList } from './link-list';
import { NoteList } from './note-list';
import { RecordDetailActions } from './record-detail-actions';
import { SourcesPanel } from './sources-panel';
import { SummariesPanel } from './summaries-panel';
import { SyncStatusBadge } from './sync-status';
import {
  KIND_LABELS,
  SERVICE_KIND,
  STATUS_LABELS,
  type HubFileItem,
  type HubKind,
  type HubLinkItem,
  type HubNoteItem,
  type HubRecord,
  type HubSourceThread,
} from './labels';

// SC-002: a record with up to 100 notes and files renders on one screen; notes and files load in one call each.
const NOTES_PER_SCREEN = 100;

/** A set value the user did not enter, edit or clear came from email (data-model.md "Provenance and owner_fields"). */
function FromEmail() {
  return <Badge variant="secondary">From email</Badge>;
}

function Field({ label, value, fromEmail }: { label: string; value: string | null | undefined; fromEmail: boolean }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        {value}
        {fromEmail ? <FromEmail /> : null}
      </dd>
    </div>
  );
}

// Shared by the three detail pages; links, notes and files (US2), the conversation summaries and sources (US3) and
// the sync badge (US7) are on this screen.
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
  const [notes, files, sources] = await Promise.all([
    listNotes(ctx, SERVICE_KIND[kind], id, { limit: NOTES_PER_SCREEN }),
    listFiles(ctx, SERVICE_KIND[kind], id),
    sourcesForRecord(ctx, SERVICE_KIND[kind], id),
  ]);
  const threads = sources.items as HubSourceThread[];
  const fromEmail = (field: string) => !r.ownerFields.includes(field);

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
          {fromEmail('name') && r.createdFrom === 'email' ? <FromEmail /> : null}
          <Badge variant="secondary">
            {r.createdFrom === 'email' ? 'Created from email' : 'Created by you'}
          </Badge>
          <SyncStatusBadge sync={sync} />
        </div>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        {kind === 'people' ? (
          <>
            <Field label="Role" value={r.roleTitle} fromEmail={fromEmail('roleTitle')} />
            <Field label="Phone" value={r.phone} fromEmail={fromEmail('phone')} />
          </>
        ) : null}
        {kind === 'companies' ? (
          <>
            <Field label="Website" value={r.website} fromEmail={fromEmail('website')} />
            <Field label="Industry" value={r.industry} fromEmail={fromEmail('industry')} />
          </>
        ) : null}
        {kind === 'projects' ? (
          <>
            <Field label="Start date" value={r.startDate} fromEmail={fromEmail('startDate')} />
            <Field label="End date" value={r.endDate} fromEmail={fromEmail('endDate')} />
          </>
        ) : null}
        <Field label="Description" value={r.description} fromEmail={fromEmail('description')} />
      </dl>

      {r.emails && r.emails.length > 0 ? (
        <section aria-label="Email addresses" className="space-y-1">
          <p className="text-muted-foreground text-sm">Email addresses</p>
          <ul>
            {r.emails.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {e.address}
                  {e.isPrimary ? ' (primary)' : ''}
                </span>
                {e.origin === 'email' ? <FromEmail /> : null}
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
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <span>{d.domain}</span>
                {d.origin === 'email' ? <FromEmail /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <RecordDetailActions kind={kind} record={r} />

      <LinkList kind={kind} recordId={r.id} links={links as HubLinkItem[]} />

      <SummariesPanel items={threads} />

      <SourcesPanel items={threads} links={links as HubLinkItem[]} />

      <NoteList kind={kind} recordId={r.id} notes={notes.items as HubNoteItem[]} />

      <section aria-labelledby="hub-files-heading" className="flex flex-col gap-3">
        <h2 id="hub-files-heading" className="text-lg font-semibold">
          Files
        </h2>
        <FileUpload kind={kind} recordId={r.id} />
        <FileList files={files as HubFileItem[]} />
      </section>
    </div>
  );
}

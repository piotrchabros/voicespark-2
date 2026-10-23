import { status } from '@voicespark/core/services/hub/sync';
import { requireUserOrRedirect } from '@/lib/page-auth';
import { SyncActions, SyncRetryButton, SyncStatusBadge } from '@/components/hub/sync-status';
import { formatSyncedAt, SYNC_ENTITY_LABELS, type HubSyncItem } from '@/components/hub/labels';

export const dynamic = 'force-dynamic';

// One screen of failed items; the rest are retried with "Retry failed".
const FAILED_PER_SCREEN = 100;

function errorText(code: string | null): string {
  if (code === 'memory_store_auth') return 'The memory store refused the connection.';
  return 'The memory store did not accept it.';
}

// Hub settings: the memory store sync section (US7, FR-026). The mailbox section is added in US3.
export default async function HubSettingsPage() {
  const ctx = await requireUserOrRedirect();
  const { counts, items } = await status(ctx, { status: 'failed', limit: FAILED_PER_SCREEN });
  const failed = items as HubSyncItem[];
  const cards = [
    { label: 'Stored', value: counts.stored },
    { label: 'Waiting', value: counts.pending },
    { label: 'Failed', value: counts.failed },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Hub settings</h1>

      <section aria-labelledby="hub-sync-heading" className="flex flex-col gap-4">
        <div className="space-y-1">
          <h2 id="hub-sync-heading" className="text-lg font-semibold">
            Memory store sync
          </h2>
          <p className="text-muted-foreground text-sm">
            A filtered copy of your records, notes, files and conversation summaries is kept in the memory store, so
            your drafts can use them. Your hub keeps everything even when the copy fails.
          </p>
        </div>
        <dl aria-label="Sync counts" className="grid gap-3 sm:grid-cols-3">
          {cards.map((c) => (
            <div key={c.label} className="rounded-lg border p-4">
              <dt className="text-muted-foreground text-sm">{c.label}</dt>
              <dd className="text-2xl font-semibold">{c.value}</dd>
            </div>
          ))}
        </dl>
        <SyncActions failed={counts.failed} pending={counts.pending} />

        {failed.length > 0 ? (
          <ul aria-label="Failed items" className="divide-y rounded-md border">
            {failed.map((i) => {
              const label = i.label || `Untitled ${SYNC_ENTITY_LABELS[i.entityType].toLowerCase()}`;
              return (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{label}</span>
                    <span className="text-muted-foreground text-xs">
                      {SYNC_ENTITY_LABELS[i.entityType]}. {errorText(i.lastErrorCode)}{' '}
                      {i.attempts} {i.attempts === 1 ? 'attempt' : 'attempts'}.
                      {i.lastSyncedAt ? ` Last stored ${formatSyncedAt(i.lastSyncedAt)}.` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <SyncStatusBadge sync={{ status: i.status, lastSyncedAt: i.lastSyncedAt }} />
                    <SyncRetryButton id={i.id} label={label} />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No failed items.</p>
        )}
      </section>
    </div>
  );
}

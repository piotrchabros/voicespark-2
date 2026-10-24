import * as ignoreRules from '@voicespark/core/services/hub/ignore-rules';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import { status } from '@voicespark/core/services/hub/sync';
import { requireUserOrRedirect } from '@/lib/page-auth';
import { IgnoreRules } from '@/components/hub/ignore-rules';
import { MailboxSettings } from '@/components/hub/mailbox-settings';
import { SyncActions, SyncRetryButton, SyncStatusBadge } from '@/components/hub/sync-status';
import {
  formatSyncedAt,
  SYNC_ENTITY_LABELS,
  type HubIgnoreRule,
  type HubMailbox,
  type HubSyncItem,
} from '@/components/hub/labels';

export const dynamic = 'force-dynamic';

// One screen of failed items; the rest are retried with "Retry failed".
const FAILED_PER_SCREEN = 100;

function errorText(code: string | null): string {
  if (code === 'memory_store_auth') return 'The memory store refused the connection.';
  return 'The memory store did not accept it.';
}

// Hub settings: the mailbox switches and ignore rules (US3; FR-012, FR-021, FR-022) and the memory store sync section
// (US7, FR-026).
export default async function HubSettingsPage() {
  const ctx = await requireUserOrRedirect();
  const [{ counts, items }, mailboxItems, rules] = await Promise.all([
    status(ctx, { status: 'failed', limit: FAILED_PER_SCREEN }),
    mailboxes.list(ctx),
    ignoreRules.list(ctx),
  ]);
  const failed = items as HubSyncItem[];
  const cards = [
    { label: 'Stored', value: counts.stored },
    { label: 'Waiting', value: counts.pending },
    { label: 'Failed', value: counts.failed },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Hub settings</h1>

      <section aria-labelledby="hub-mailboxes-heading" className="flex flex-col gap-4">
        <div className="space-y-1">
          <h2 id="hub-mailboxes-heading" className="text-lg font-semibold">
            Mailboxes
          </h2>
          <p className="text-muted-foreground text-sm">
            The hub is off for every mailbox until you turn it on. With the hub on, VoiceSpark reads that mailbox&apos;s
            conversations to find the people, companies and projects in them.
          </p>
        </div>
        <MailboxSettings items={mailboxItems as HubMailbox[]} />
      </section>

      <section aria-labelledby="hub-ignore-heading" className="flex flex-col gap-4">
        <div className="space-y-1">
          <h2 id="hub-ignore-heading" className="text-lg font-semibold">
            Ignored senders and domains
          </h2>
          <p className="text-muted-foreground text-sm">
            Mail from an ignored sender or domain creates and updates nothing in the hub. Removing a rule restores
            processing for later mail.
          </p>
        </div>
        <IgnoreRules rules={rules as HubIgnoreRule[]} />
      </section>

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

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  BACKFILL_STATE_TEXT,
  formatSyncedAt,
  HUB_AI_NOTICE,
  hubApiError,
  plural,
  THREAD_ERROR_TEXT,
  type HubFailedThread,
  type HubMailbox,
} from './labels';

/** Counters move while earlier mail is read; the page refreshes until the backfill is done. */
const REFRESH_MS = 5000;

async function post(path: string, body?: unknown): Promise<Response | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      toast.error(await hubApiError(res));
      return null;
    }
    return res;
  } catch {
    toast.error('Network error. Try again.');
    return null;
  }
}

// FR-012: the hub is off until the user reads the notice and acknowledges that content goes to the AI service.
function ConsentDialog({
  mailbox,
  open,
  onOpenChange,
  onEnabled,
}: {
  mailbox: HubMailbox;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const checkboxId = `hub-ai-ack-${mailbox.sourceId}`;

  function changeOpen(next: boolean) {
    if (!next) setAcknowledged(false);
    onOpenChange(next);
  }

  async function confirm() {
    setPending(true);
    const res = await post(`/api/hub/mailboxes/${mailbox.sourceId}/enable`, { acknowledgeAi: true });
    setPending(false);
    if (!res) return;
    toast.success(`Hub turned on for ${mailbox.accountLabel}.`);
    changeOpen(false);
    onEnabled();
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn the hub on for {mailbox.accountLabel}?</DialogTitle>
          <DialogDescription>{HUB_AI_NOTICE}</DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          Newsletters, notifications, your own addresses and generic role addresses are skipped. You can turn this off
          at any time and choose whether to keep what was found.
        </p>
        <div className="flex items-start gap-2">
          <Checkbox
            id={checkboxId}
            checked={acknowledged}
            onCheckedChange={(v) => setAcknowledged(v === true)}
            aria-required
          />
          <Label htmlFor={checkboxId} className="leading-snug font-normal">
            I understand that conversation content is sent to the AI service.
          </Label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!acknowledged || pending} onClick={() => void confirm()}>
            Turn on
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// FR-031: turning the hub off asks what happens to the data derived from this mailbox. The radio names carry the
// source id, so two mailboxes on one page never share a group.
function DataChoiceDialog({
  mailbox,
  open,
  onOpenChange,
  onDisabled,
}: {
  mailbox: HubMailbox;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisabled: () => void;
}) {
  const [choice, setChoice] = useState<'keep' | 'delete'>('keep');
  const [pending, setPending] = useState(false);
  const group = `hub-data-${mailbox.sourceId}`;

  function changeOpen(next: boolean) {
    if (!next) setChoice('keep');
    onOpenChange(next);
  }

  async function confirm() {
    setPending(true);
    const res = await post(`/api/hub/mailboxes/${mailbox.sourceId}/disable`, { hubData: choice });
    setPending(false);
    if (!res) return;
    toast.success(
      choice === 'delete'
        ? `Hub turned off for ${mailbox.accountLabel}. Data from this mailbox is being deleted.`
        : `Hub turned off for ${mailbox.accountLabel}. Data from this mailbox is kept.`,
    );
    changeOpen(false);
    onDisabled();
  }

  const options: { value: 'keep' | 'delete'; label: string; help: string }[] = [
    {
      value: 'keep',
      label: 'Keep what was found',
      help: 'Records, values, links and summaries from this mailbox stay in your hub. Nothing new is read.',
    },
    {
      value: 'delete',
      label: 'Delete what was found',
      help: 'Summaries, values and links that came only from this mailbox are removed. Anything you entered yourself stays.',
    },
  ];

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn the hub off for {mailbox.accountLabel}?</DialogTitle>
          <DialogDescription>Processing stops. Choose what happens to the data derived from this mailbox.</DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Data from this mailbox</legend>
          {options.map((o) => {
            const id = `${group}-${o.value}`;
            return (
              <div key={o.value} className="flex items-start gap-2">
                <input
                  id={id}
                  type="radio"
                  name={group}
                  value={o.value}
                  checked={choice === o.value}
                  onChange={() => setChoice(o.value)}
                  className="mt-1"
                />
                <Label htmlFor={id} className="flex flex-col items-start gap-1 font-normal">
                  <span className="font-medium">{o.label}</span>
                  <span className="text-muted-foreground text-xs">{o.help}</span>
                </Label>
              </div>
            );
          })}
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={choice === 'delete' ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => void confirm()}
          >
            Turn off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function failedText(t: HubFailedThread): string {
  const why = t.errorCode ? (THREAD_ERROR_TEXT[t.errorCode] ?? 'Processing failed.') : 'Processing failed.';
  const when = t.lastAttemptAt ? ` Last tried ${formatSyncedAt(t.lastAttemptAt)}.` : '';
  return `${why} ${plural(t.attempts, 'attempt')}.${when}`;
}

/** Subjects are not available for failed conversations (nothing was stored), so the row is identified by position. */
function FailedThreadRow({ mailbox, thread, index }: { mailbox: HubMailbox; thread: HubFailedThread; index: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const label = `Conversation ${index + 1}`;

  async function retry() {
    setBusy(true);
    const res = await post(`/api/hub/mailboxes/${mailbox.sourceId}/threads/${thread.id}/retry`);
    setBusy(false);
    if (!res) return;
    toast.success('Queued again.');
    router.refresh();
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-3" data-thread-id={thread.id}>
      <div className="flex flex-col gap-1">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{failedText(thread)}</span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Retry ${label.toLowerCase()} of ${mailbox.accountLabel}`}
        disabled={busy}
        onClick={() => void retry()}
      >
        Retry
      </Button>
    </li>
  );
}

function MailboxCard({ mailbox }: { mailbox: HubMailbox }) {
  const router = useRouter();
  const [consentOpen, setConsentOpen] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const switchId = `hub-switch-${mailbox.sourceId}`;
  const counters = [
    { label: 'Processed', value: mailbox.threadsProcessed },
    { label: 'Skipped', value: mailbox.threadsSkipped },
    { label: 'Failed', value: mailbox.threadsFailed },
  ];
  const backfillText = mailbox.enabled ? BACKFILL_STATE_TEXT[mailbox.backfillState] : null;

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4" data-source-id={mailbox.sourceId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span id={`${switchId}-label`} className="font-medium break-all">
            {mailbox.accountLabel}
          </span>
          <span className="text-muted-foreground text-xs">
            {mailbox.status === 'connected' ? 'Connected' : mailbox.status.replace(/_/g, ' ')}
            {mailbox.enabled && mailbox.enabledAt ? `. Hub on since ${formatSyncedAt(mailbox.enabledAt)}` : ''}
            {!mailbox.enabled && mailbox.dataChoice ? `. Data ${mailbox.dataChoice === 'keep' ? 'kept' : 'deleted'}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={mailbox.enabled ? 'default' : 'outline'} data-hub-enabled={mailbox.enabled}>
            Hub {mailbox.enabled ? 'on' : 'off'}
          </Badge>
          <Button
            id={switchId}
            type="button"
            role="switch"
            aria-checked={mailbox.enabled}
            aria-label={`Hub for ${mailbox.accountLabel}`}
            variant="outline"
            size="sm"
            onClick={() => (mailbox.enabled ? setChoiceOpen(true) : setConsentOpen(true))}
          >
            {mailbox.enabled ? 'Turn off' : 'Turn on'}
          </Button>
        </div>
      </div>

      {mailbox.enabled ? (
        <>
          <dl aria-label={`Hub counts for ${mailbox.accountLabel}`} className="grid gap-3 sm:grid-cols-3">
            {counters.map((c) => (
              <div key={c.label} className="rounded-md border p-3">
                <dt className="text-muted-foreground text-xs">{c.label}</dt>
                <dd className="text-xl font-semibold">{c.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-sm">
            {mailbox.lastRunAt ? `Last run ${formatSyncedAt(mailbox.lastRunAt)}.` : 'No conversation processed yet.'}
            {backfillText ? ` ${backfillText}` : ''}
          </p>
          {mailbox.pausedUntil ? (
            <p role="status" className="text-sm">
              Paused until tomorrow: the daily limit was reached. Processing resumes at{' '}
              {formatSyncedAt(mailbox.pausedUntil)}.
            </p>
          ) : null}
          {mailbox.failedThreads.length > 0 ? (
            <ul aria-label={`Failed conversations of ${mailbox.accountLabel}`} className="divide-y rounded-md border">
              {mailbox.failedThreads.map((t, i) => (
                <FailedThreadRow key={t.id} mailbox={mailbox} thread={t} index={i} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <ConsentDialog mailbox={mailbox} open={consentOpen} onOpenChange={setConsentOpen} onEnabled={() => router.refresh()} />
      <DataChoiceDialog mailbox={mailbox} open={choiceOpen} onOpenChange={setChoiceOpen} onDisabled={() => router.refresh()} />
    </li>
  );
}

/** The per-mailbox hub switch with its counters and failed conversations (US3; FR-012, FR-022, FR-031). */
export function MailboxSettings({ items }: { items: HubMailbox[] }) {
  const router = useRouter();
  const reading = items.some((m) => m.enabled && (m.backfillState === 'pending' || m.backfillState === 'running'));

  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reading, router]);

  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">No mailbox is connected. Connect one under Sources first.</p>;
  }
  return (
    <ul aria-label="Mailboxes" className="flex flex-col gap-3">
      {items.map((m) => (
        <MailboxCard key={m.sourceId} mailbox={m} />
      ))}
    </ul>
  );
}

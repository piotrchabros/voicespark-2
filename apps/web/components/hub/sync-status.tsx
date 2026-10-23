'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatSyncedAt, hubApiError, SYNC_STATUS_LABELS, type HubSyncField } from './labels';

const REFRESH_MS = 3000;

// Memory store copy of one record, note or file (US7, FR-026): `stored | waiting | failed` with the last store time.
export function SyncStatusBadge({ sync }: { sync: HubSyncField }) {
  const label = SYNC_STATUS_LABELS[sync.status];
  const when = sync.lastSyncedAt ? `Last stored ${formatSyncedAt(sync.lastSyncedAt)}` : 'Not stored yet';
  return (
    <Badge
      variant={sync.status === 'failed' ? 'destructive' : sync.status === 'stored' ? 'secondary' : 'outline'}
      title={when}
      data-sync-status={sync.status}
    >
      Sync: {label}
      <span className="sr-only">. {when}</span>
    </Badge>
  );
}

async function post(path: string, body: unknown): Promise<number | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      toast.error(await hubApiError(res));
      return null;
    }
    return ((await res.json()) as { requeued: number }).requeued;
  } catch {
    toast.error('Network error. Try again.');
    return null;
  }
}

/** Retry and re-sync buttons of the settings sync section; refreshes the page while items are waiting. */
export function SyncActions({ failed, pending }: { failed: number; pending: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pending === 0) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending, router]);

  async function run(path: string, done: (n: number) => string) {
    setBusy(true);
    const requeued = await post(path, {});
    setBusy(false);
    if (requeued === null) return;
    toast.success(done(requeued));
    router.refresh();
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        disabled={busy || failed === 0}
        onClick={() => void run('/api/hub/sync/retry', (n) => `${n} failed ${n === 1 ? 'item' : 'items'} queued again.`)}
      >
        Retry failed
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void run('/api/hub/sync/resync', (n) => `Re-sync started for ${n} ${n === 1 ? 'item' : 'items'}.`)}
      >
        Re-sync everything
      </Button>
    </div>
  );
}

/** Retry of one failed item. */
export function SyncRetryButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    const requeued = await post('/api/hub/sync/retry', { ids: [id] });
    setBusy(false);
    if (requeued === null) return;
    toast.success(requeued > 0 ? 'Queued again.' : 'This item is no longer failed.');
    router.refresh();
  }
  return (
    <Button variant="ghost" size="sm" aria-label={`Retry ${label}`} disabled={busy} onClick={() => void retry()}>
      Retry
    </Button>
  );
}

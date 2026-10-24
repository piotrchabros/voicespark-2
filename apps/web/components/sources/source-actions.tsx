'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HUB_DATA_OPTIONS, type HubDataChoice } from '@/components/hub/labels';

interface Props {
  sourceId: string;
  type: string;
  status: string;
  accountLabel?: string;
  itemCount?: number;
  lastSyncAt?: string | null;
  /** The hub reads this mailbox: disconnecting asks to keep or delete the derived data (FR-031). */
  hubEnabled?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  microsoft: 'Microsoft 365',
  imap: 'IMAP',
  uploads: 'Uploads',
};

// Shared with the account page's deletion status view (same key, string literal).
function rememberDeletion(id: string) {
  try {
    const raw = sessionStorage.getItem('vs.pendingDeletions');
    const ids: unknown = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(ids) ? (ids as string[]) : [];
    if (!list.includes(id))
      sessionStorage.setItem('vs.pendingDeletions', JSON.stringify([...list, id]));
  } catch {
    // sessionStorage unavailable: the deletion still proceeds.
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

export function SourceActions({
  sourceId,
  type,
  status,
  accountLabel,
  itemCount,
  lastSyncAt,
  hubEnabled = false,
}: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [deleteContent, setDeleteContent] = useState(false);
  const [hubData, setHubData] = useState<HubDataChoice>('keep');
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [deleteDataOpen, setDeleteDataOpen] = useState(false);

  async function call(action: string, body?: unknown): Promise<Response | null> {
    setPending(true);
    try {
      const res = await fetch(`/api/sources/${sourceId}/${action}`, {
        method: 'POST',
        ...(body !== undefined
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res));
        return null;
      }
      return res;
    } catch {
      toast.error('Network error. Try again.');
      return null;
    } finally {
      setPending(false);
    }
  }

  async function simple(action: 'pause' | 'resume') {
    if (await call(action)) router.refresh();
  }

  async function reconnect() {
    if (type === 'imap') {
      if (!password) return;
      const res = await call('reconnect', { password });
      setPassword('');
      if (res) {
        setReconnectOpen(false);
        router.refresh();
      }
      return;
    }
    const res = await call('reconnect');
    if (!res) return;
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    window.location.assign(authorizeUrl);
  }

  async function disconnect() {
    const res = await call('disconnect', hubEnabled ? { deleteContent, hubData } : { deleteContent });
    if (res) {
      setDisconnectOpen(false);
      router.refresh();
    }
  }

  async function deleteData() {
    setPending(true);
    try {
      const res = await fetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(res.status === 409 ? 'Deletion already in progress.' : await errorMessage(res));
        return;
      }
      const { deletionRequestId } = (await res.json()) as { deletionRequestId?: string };
      if (deletionRequestId) rememberDeletion(deletionRequestId);
      setDeleteDataOpen(false);
      toast.success('Deletion started');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {status === 'connected' ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => simple('pause')}>
          Pause
        </Button>
      ) : null}
      {status === 'paused' ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => simple('resume')}>
          Resume
        </Button>
      ) : null}
      {status === 'needs_reconnection' ? (
        <Button
          size="sm"
          disabled={pending}
          onClick={() => (type === 'imap' ? setReconnectOpen(true) : void reconnect())}
        >
          Reconnect
        </Button>
      ) : null}
      {status !== 'disconnected' ? (
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => setDisconnectOpen(true)}
        >
          Disconnect
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() => setDeleteDataOpen(true)}
      >
        Delete data
      </Button>

      <Dialog open={deleteDataOpen} onOpenChange={setDeleteDataOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all data from this source?</DialogTitle>
            <DialogDescription>
              This removes the source and everything imported from it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd>{TYPE_LABELS[type] ?? type}</dd>
            {accountLabel !== undefined ? (
              <>
                <dt className="text-muted-foreground">Account</dt>
                <dd className="break-all">{accountLabel}</dd>
              </>
            ) : null}
            {itemCount !== undefined ? (
              <>
                <dt className="text-muted-foreground">Items</dt>
                <dd>{itemCount}</dd>
              </>
            ) : null}
            {lastSyncAt !== undefined ? (
              <>
                <dt className="text-muted-foreground">Last sync</dt>
                <dd>{lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'Never'}</dd>
              </>
            ) : null}
          </dl>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDataOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => void deleteData()}>
              {pending ? 'Deleting...' : 'Delete data'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect this source?</DialogTitle>
            <DialogDescription>Syncing stops and stored credentials are removed.</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2">
            <Checkbox
              id={`delete-${sourceId}`}
              checked={deleteContent}
              onCheckedChange={(v) => setDeleteContent(v === true)}
            />
            <Label htmlFor={`delete-${sourceId}`}>
              Also delete this mailbox&apos;s content from the memory store?
            </Label>
          </div>
          {hubEnabled ? (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-medium">Hub data from this mailbox</legend>
              {HUB_DATA_OPTIONS.map((o) => {
                const id = `hub-data-${sourceId}-${o.value}`;
                return (
                  <div key={o.value} className="flex items-start gap-2">
                    <input
                      id={id}
                      type="radio"
                      name={`hub-data-${sourceId}`}
                      value={o.value}
                      checked={hubData === o.value}
                      onChange={() => setHubData(o.value)}
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
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={disconnect}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reconnectOpen} onOpenChange={setReconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconnect mailbox</DialogTitle>
            <DialogDescription>Enter the app password again to resume syncing.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`pw-${sourceId}`}>App password</Label>
            <Input
              id={`pw-${sourceId}`}
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReconnectOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || !password} onClick={reconnect}>
              Reconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

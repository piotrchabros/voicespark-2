'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Retroscan {
  id: string;
  status: string;
  matchedCount: number;
}

const POLL_MS = 2000;

export function RetroscanDialog({ retroscanId, onClose }: { retroscanId: string | null; onClose: () => void }) {
  const [latest, setLatest] = useState<Retroscan | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!retroscanId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`/api/retroscans/${retroscanId}`);
        if (!res.ok) throw new Error('retroscan_failed');
        const next = (await res.json()) as Retroscan;
        if (cancelled) return;
        setLatest(next);
        if (next.status === 'scanning') timer = setTimeout(tick, POLL_MS);
      } catch {
        if (!cancelled) setLatest({ id: retroscanId, status: 'failed', matchedCount: 0 });
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [retroscanId]);

  async function act(action: 'confirm' | 'dismiss') {
    if (!retroscanId) return;
    setPending(true);
    try {
      const res = await fetch(`/api/retroscans/${retroscanId}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error('retroscan_action_failed');
      if (action === 'confirm') toast.success('Removing matching items.');
      onClose();
    } catch {
      toast.error('Could not complete that action.');
    } finally {
      setPending(false);
    }
  }

  // Ignore a result left over from a previously shown scan.
  const scan = latest && latest.id === retroscanId ? latest : null;
  const status = scan?.status ?? 'scanning';
  let description = 'Checking your existing content...';
  if (status === 'awaiting_confirmation') {
    description = `${scan?.matchedCount ?? 0} existing items match your new settings.`;
  } else if (status === 'no_matches') {
    description = 'No existing items match, so nothing needs to be removed.';
  } else if (status === 'failed') {
    description = 'The check could not be completed. Your existing content was not changed.';
  } else if (status !== 'scanning') {
    description = 'This check is already finished.';
  }

  return (
    <Dialog open={retroscanId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check existing content</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {status === 'awaiting_confirmation' ? (
            <>
              <Button variant="outline" disabled={pending} onClick={() => act('dismiss')}>
                Keep
              </Button>
              <Button variant="destructive" disabled={pending} onClick={() => act('confirm')}>
                Remove {scan?.matchedCount ?? 0} matching items
              </Button>
            </>
          ) : status === 'scanning' ? null : (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
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

const CONFIRM_WORD = 'DELETE';

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code === 'last_admin')
      return 'You are the last admin. Grant admin to someone else first.';
    return body.error?.message ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

export function DeleteAccountDialog() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConfirm('');
      setError(null);
    }
  }

  async function submit() {
    if (confirm !== CONFIRM_WORD) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: CONFIRM_WORD }),
      });
      if (res.status === 202) {
        // The session is revoked with the request, so there is nothing to poll here (D-U7b). A full load drops
        // all client state of the deleted account.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign('/sign-in?deleted=1');
        return;
      }
      setError(await errorMessage(res));
    } catch {
      setError('Network error. Try again.');
    }
    setPending(false);
  }

  return (
    <>
      <Button variant="destructive" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        Delete account
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              All your content, voice profiles, drafts and memory-store data are removed within 24
              hours. You are signed out now and receive a confirmation email when deletion is
              complete. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="delete-account-confirm">
              Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
            </Label>
            <Input
              id="delete-account-confirm"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="border-destructive/50 text-destructive rounded-md border p-3 text-sm"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending || confirm !== CONFIRM_WORD}
              onClick={submit}
            >
              {pending ? 'Deleting...' : 'Delete account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

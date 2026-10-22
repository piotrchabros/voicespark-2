'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export function OutdatedBanner({ profiles }: { profiles: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (profiles.length === 0) return null;

  async function regenerate(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${id}/regenerate`, { method: 'POST' });
      if (res.status === 429) {
        setError('You have requested too many generations. Please try again later.');
        return;
      }
      if (!res.ok) {
        setError('Could not start regeneration. Please try again.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not start regeneration. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 sm:p-4"
    >
      <div className="space-y-1">
        <p className="font-medium">Your profile may be outdated</p>
        <p className="text-muted-foreground text-sm">
          Some of the content it was built from has been deleted. Regenerate to refresh it.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {profiles.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words text-sm">{p.name}</span>
            <Button size="sm" disabled={busyId !== null} onClick={() => void regenerate(p.id)}>
              {busyId === p.id ? 'Starting...' : 'Regenerate'}
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

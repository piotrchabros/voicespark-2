'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface IdentityItem {
  id: string;
  provider: string;
  providerEmail: string | null;
  emailVerified: boolean;
  isRelayEmail: boolean;
  linkedAt: string;
  linkedVia: string;
}

const LABELS: Record<string, string> = {
  google: 'Google',
  apple: 'Apple',
  microsoft: 'Microsoft',
  facebook: 'Facebook',
};

const VIA: Record<string, string> = {
  signup: 'sign-up',
  confirmed_link: 'confirmed link',
  manual_link: 'manual link',
};

export function IdentityList({ identities }: { identities: IdentityItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onlyOne = identities.length <= 1;

  async function unlink(id: string) {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/identities/${id}`, { method: 'DELETE' });
    setBusy(null);
    if (res.ok) {
      router.refresh();
    } else {
      setError('Could not unlink this identity.');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {identities.map((i) => (
          <li
            key={i.id}
            className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{LABELS[i.provider] ?? i.provider}</p>
              <p className="text-muted-foreground text-sm break-all">
                {i.providerEmail && !i.isRelayEmail ? i.providerEmail : 'Email hidden (relay)'}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={i.emailVerified ? 'secondary' : 'outline'}>
                  {i.emailVerified ? 'Verified' : 'Unverified'}
                </Badge>
                <span className="text-muted-foreground">
                  Linked via {VIA[i.linkedVia] ?? i.linkedVia} on {new Date(i.linkedAt).toLocaleDateString('en-GB')}
                </span>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={onlyOne || busy !== null}
              title={onlyOne ? 'You cannot unlink your last sign-in method' : undefined}
              onClick={() => void unlink(i.id)}
            >
              Unlink
            </Button>
          </li>
        ))}
      </ul>
      {onlyOne ? (
        <p className="text-muted-foreground text-sm">Your last sign-in method cannot be unlinked.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

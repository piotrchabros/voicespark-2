'use client';

import { useState, useSyncExternalStore } from 'react';
import type { SignInProvider } from '@voicespark/db';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

const noopSubscribe = () => () => {};

type LinkVia = 'confirmed_link' | 'manual_link';

const PROVIDERS: { id: SignInProvider; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'apple', label: 'Apple' },
  { id: 'microsoft', label: 'Microsoft' },
  { id: 'facebook', label: 'Facebook' },
];

export function ProviderButtons(props: {
  mode: 'sign-in' | 'link';
  callbackURL?: string;
  via?: LinkVia;
  exclude?: SignInProvider[];
}) {
  const [busy, setBusy] = useState<SignInProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Server-rendered buttons have no click handler until React hydrates; keep them disabled until then so an
  // early click is not silently dropped. Server snapshot is false, client snapshot true.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const providers = PROVIDERS.filter((p) => !props.exclude?.includes(p.id));

  async function go(provider: SignInProvider) {
    setBusy(provider);
    setError(null);
    try {
      if (props.mode === 'sign-in') {
        const res = await authClient.signIn.social({
          provider,
          callbackURL: props.callbackURL ?? '/dashboard',
          errorCallbackURL: `/oauth-error?provider=${provider}`,
        });
        if (res.error) throw new Error(res.error.message);
        return;
      }
      const res = await fetch('/api/identities/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, via: props.via ?? 'manual_link' }),
      });
      if (!res.ok) throw new Error('link failed');
      const { redirectUrl } = (await res.json()) as { redirectUrl: string };
      window.location.assign(redirectUrl);
    } catch {
      setError('Something went wrong. Please try again.');
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {providers.map((p) => (
        <Button
          key={p.id}
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          disabled={!hydrated || busy !== null}
          onClick={() => void go(p.id)}
        >
          {props.mode === 'sign-in' ? `Continue with ${p.label}` : `Link ${p.label}`}
        </Button>
      ))}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

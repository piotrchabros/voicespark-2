'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  domainOfAddress,
  formatSyncedAt,
  hubApiError,
  IGNORE_RULE_KIND_LABELS,
  readHubError,
  type HubIgnoreRule,
  type IgnoreRuleKind,
} from './labels';

// Ignore rules (US3, FR-021): mail from an ignored sender or domain creates and updates nothing. Rules apply when a
// conversation is processed, so removing one restores processing for later mail.

const VALUE_MAX = 320;

async function createRule(kind: IgnoreRuleKind, value: string): Promise<'created' | 'exists' | 'failed'> {
  try {
    const res = await fetch('/api/hub/ignore-rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, value }),
    });
    if (res.ok) return 'created';
    const failure = await readHubError(res);
    if (failure.code === 'conflict') return 'exists';
    toast.error(failure.code === 'validation_failed' ? `Enter a valid ${kind === 'address' ? 'email address' : 'domain'}.` : failure.message);
    return 'failed';
  } catch {
    toast.error('Network error. Try again.');
    return 'failed';
  }
}

/** "Ignore sender" and "Ignore domain" next to a participant of a conversation summary. */
export function IgnoreParticipantActions({ address }: { address: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const domain = domainOfAddress(address);

  async function ignore(kind: IgnoreRuleKind, value: string) {
    setBusy(true);
    const outcome = await createRule(kind, value);
    setBusy(false);
    if (outcome === 'failed') return;
    toast.success(outcome === 'exists' ? `${value} is already ignored.` : `${value} is ignored from now on.`);
    router.refresh();
  }

  return (
    <span className="inline-flex gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        aria-label={`Ignore sender ${address}`}
        disabled={busy}
        onClick={() => void ignore('address', address)}
      >
        Ignore sender
      </Button>
      {domain ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          aria-label={`Ignore domain ${domain}`}
          disabled={busy}
          onClick={() => void ignore('domain', domain)}
        >
          Ignore domain
        </Button>
      ) : null}
    </span>
  );
}

function RemoveRuleButton({ rule }: { rule: HubIgnoreRule }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(`/api/hub/ignore-rules/${rule.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await hubApiError(res));
        return;
      }
      toast.success(`${rule.value} is no longer ignored.`);
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" aria-label={`Stop ignoring ${rule.value}`} disabled={busy} onClick={() => void remove()}>
      Remove
    </Button>
  );
}

/** The settings section: the list of rules, a form to add one, and removal. */
export function IgnoreRules({ rules }: { rules: HubIgnoreRule[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<IgnoreRuleKind>('address');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      setError(`Enter ${kind === 'address' ? 'an email address' : 'a domain'}.`);
      return;
    }
    if (trimmed.length > VALUE_MAX) {
      setError(`Must be at most ${VALUE_MAX} characters.`);
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await createRule(kind, trimmed);
    setPending(false);
    if (outcome === 'failed') return;
    if (outcome === 'exists') {
      setError('This rule already exists.');
      return;
    }
    toast.success(`${trimmed} is ignored from now on.`);
    setValue('');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label="Add an ignore rule">
        <fieldset className="flex flex-wrap gap-4">
          <legend className="sr-only">Rule kind</legend>
          {(['address', 'domain'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="hub-ignore-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {IGNORE_RULE_KIND_LABELS[k]}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1">
          <Label htmlFor="hub-ignore-value">{kind === 'address' ? 'Email address to ignore' : 'Domain to ignore'}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="hub-ignore-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === 'address' ? 'name@example.com' : 'example.com'}
              maxLength={VALUE_MAX}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'hub-ignore-error' : undefined}
              className="max-w-sm"
            />
            <Button type="submit" variant="outline" disabled={pending}>
              Ignore
            </Button>
          </div>
          {error ? (
            <p id="hub-ignore-error" role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
      </form>

      {rules.length > 0 ? (
        <ul aria-label="Ignored senders and domains" className="divide-y rounded-md border">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="flex flex-col gap-1">
                <span className="font-medium break-all">{r.value}</span>
                <span className="text-muted-foreground text-xs">
                  {IGNORE_RULE_KIND_LABELS[r.kind]}. Added {formatSyncedAt(r.createdAt)}.
                </span>
              </div>
              <RemoveRuleButton rule={r} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing is ignored.</p>
      )}
    </div>
  );
}

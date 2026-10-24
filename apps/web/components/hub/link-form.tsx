'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  KIND_LABELS,
  LINK_ROLE_MAX,
  SERVICE_KIND,
  linkKindFor,
  readHubError,
  type HubKind,
} from './labels';

const KINDS: HubKind[] = ['people', 'companies', 'projects'];
const SELECT_CLASS = 'h-9 rounded-md border bg-background px-2 text-sm';
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// FR-007: links this record to a record of one of the two other kinds (a same-kind pair is never offered). A second
// link for the same pair is refused by the server (`link_exists`); the form then hands the existing link to the role
// editor of the list.
export function LinkForm({
  kind,
  recordId,
  onExists,
}: {
  kind: HubKind;
  recordId: string;
  onExists: (linkId: string) => void;
}) {
  const router = useRouter();
  const targets = KINDS.filter((k) => k !== kind);
  const [target, setTarget] = useState<HubKind>(targets[0]!);
  const [loaded, setLoaded] = useState<{ target: HubKind; items: { id: string; name: string }[] } | null>(null);
  const options = loaded?.target === target ? loaded.items : null;
  const [otherId, setOtherId] = useState('');
  const [role, setRole] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/hub/${target}?sort=name&order=asc&limit=100`);
        if (!res.ok) throw new Error('list');
        const data = (await res.json()) as { items: { id: string; name: string }[] };
        if (!cancelled) setLoaded({ target, items: data.items });
      } catch {
        if (!cancelled) setLoaded({ target, items: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const linkKind = linkKindFor(kind, target);
    if (!linkKind) return;
    if (!otherId) {
      setError(`Choose a ${KIND_LABELS[target].singular} to link.`);
      return;
    }
    if (role.trim().length > LINK_ROLE_MAX) {
      setError(`Role must be at most ${LINK_ROLE_MAX} characters.`);
      return;
    }
    const ids: Record<string, string> = {
      [`${SERVICE_KIND[kind]}Id`]: recordId,
      [`${SERVICE_KIND[target]}Id`]: otherId,
    };
    setPending(true);
    try {
      const res = await fetch('/api/hub/links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: linkKind, ...ids, role: role.trim() || null }),
      });
      if (!res.ok) {
        const failure = await readHubError(res);
        if (failure.code === 'link_exists' && failure.details.linkId) {
          setNotice(failure.message);
          onExists(failure.details.linkId);
        } else setError(failure.message);
        return;
      }
      const data = (await res.json()) as { redactedValues?: number };
      toast.success('Link added.');
      if (data.redactedValues) toast.info(`${data.redactedValues} sensitive value(s) were redacted before saving.`);
      setRole('');
      setOtherId('');
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-md border p-3" aria-label="Add a link">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="hub-link-target">Link to</Label>
          <select
            id="hub-link-target"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value as HubKind);
              setOtherId('');
            }}
            className={SELECT_CLASS}
          >
            {targets.map((k) => (
              <option key={k} value={k}>
                {capitalise(KIND_LABELS[k].singular)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="hub-link-record">Record</Label>
          <select
            id="hub-link-record"
            value={otherId}
            disabled={options === null}
            onChange={(e) => setOtherId(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">
              {options === null
                ? 'Loading...'
                : options.length === 0
                  ? `No ${KIND_LABELS[target].plural.toLowerCase()} yet`
                  : `Choose a ${KIND_LABELS[target].singular}`}
            </option>
            {(options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="hub-link-role">Role (optional)</Label>
          <Input id="hub-link-role" value={role} onChange={(e) => setRole(e.target.value)} className="w-56" />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          Add link
        </Button>
      </div>
    </form>
  );
}

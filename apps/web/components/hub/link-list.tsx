'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LinkForm } from './link-form';
import {
  KIND_LABELS,
  KIND_PATH,
  LINK_ROLE_MAX,
  hubApiError,
  type HubKind,
  type HubLinkItem,
} from './labels';

function RoleEditor({ item, onDone }: { item: HubLinkItem; onDone: () => void }) {
  const router = useRouter();
  const [role, setRole] = useState(item.link.role ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputId = `hub-link-role-${item.link.id}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (role.trim().length > LINK_ROLE_MAX) {
      setError(`Role must be at most ${LINK_ROLE_MAX} characters.`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/hub/links/${item.link.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: role.trim() || null }),
      });
      if (!res.ok) {
        setError(await hubApiError(res));
        return;
      }
      toast.success('Role saved.');
      onDone();
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-1">
      <Label htmlFor={inputId}>Role for {item.other.name}</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          value={role}
          autoFocus
          className="w-56"
          aria-invalid={error ? true : undefined}
          onChange={(e) => setRole(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={pending}>
          Update role
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// Links section of the detail screen (US2, FR-007): the linked records with their roles, a role editor per link
// (also opened by the form when the pair is already linked) and removal. Linked records themselves are kept.
export function LinkList({ kind, recordId, links }: { kind: HubKind; recordId: string; links: HubLinkItem[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function remove(id: string) {
    setPending(true);
    try {
      const res = await fetch(`/api/hub/links/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await hubApiError(res));
        return;
      }
      toast.success('Link removed.');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="hub-links-heading" className="flex flex-col gap-3">
      <h2 id="hub-links-heading" className="text-lg font-semibold">
        Links
      </h2>
      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">No links yet.</p>
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Linked records">
          {links.map((item) => {
            const path = KIND_PATH[item.other.kind];
            return (
              <li key={item.link.id} className="flex flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{KIND_LABELS[path].singular}</Badge>
                    <Link href={`/hub/${path}/${item.other.id}`} className="underline underline-offset-4">
                      {item.other.name}
                    </Link>
                    {item.link.role ? <span className="text-sm">{item.link.role}</span> : null}
                    {item.link.origin === 'email' ? <Badge variant="secondary">From email</Badge> : null}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Change role for ${item.other.name}`}
                      onClick={() => setEditingId(item.link.id)}
                    >
                      Change role
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove link to ${item.other.name}`}
                      disabled={pending}
                      onClick={() => void remove(item.link.id)}
                    >
                      Remove link
                    </Button>
                  </div>
                </div>
                {editingId === item.link.id ? (
                  <RoleEditor key={item.link.id} item={item} onDone={() => setEditingId(null)} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <LinkForm kind={kind} recordId={recordId} onExists={setEditingId} />
    </section>
  );
}

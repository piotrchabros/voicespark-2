'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export interface DefinitionOption {
  id: string;
  name: string;
  description: string;
  chosen: boolean;
}

export function DefinitionChooser({ definitions }: { definitions: DefinitionOption[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(definitions.filter((d) => d.chosen).map((d) => d.id)),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/definition-choices', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definitionIds: [...selected] }),
      });
      if (!res.ok) {
        setMessage({ ok: false, text: 'Could not save your choice. Please try again.' });
        return;
      }
      setMessage({ ok: true, text: 'Saved.' });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not save your choice. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (definitions.length === 0) {
    return <p className="text-muted-foreground text-sm">No definitions are available yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {definitions.map((d) => (
          <li key={d.id} className="flex items-start gap-3">
            <Checkbox
              id={`def-${d.id}`}
              className="mt-1"
              checked={selected.has(d.id)}
              onCheckedChange={(v) => toggle(d.id, v === true)}
            />
            <Label htmlFor={`def-${d.id}`} className="flex flex-col items-start gap-1">
              <span className="font-medium">{d.name}</span>
              <span className="text-muted-foreground text-sm font-normal">{d.description}</span>
            </Label>
          </li>
        ))}
      </ul>
      <Button className="self-start" onClick={save} disabled={busy || selected.size === 0}>
        {busy ? 'Saving...' : 'Save choice'}
      </Button>
      {message ? (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={message.ok ? 'text-sm' : 'text-destructive text-sm'}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

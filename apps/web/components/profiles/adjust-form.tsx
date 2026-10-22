'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface AdjustDimension {
  key: string;
  name: string;
  valueType: 'scale' | 'enum' | 'text' | 'list';
  scale?: { min: number; max: number; minLabel: string; maxLabel: string };
  allowedValues?: string[];
  value: number | string | string[] | null;
}

const NOTE_MAX = 2000;

interface ErrorBody {
  error?: { code?: string; message?: string; details?: { fields?: unknown; field?: unknown } };
}

function toDraft(d: AdjustDimension): string {
  if (Array.isArray(d.value)) return d.value.join('\n');
  if (d.value === null) return d.valueType === 'scale' && d.scale ? String(d.scale.min) : '';
  return String(d.value);
}

function fromDraft(d: AdjustDimension, draft: string): number | string | string[] {
  if (d.valueType === 'scale') return Number(draft);
  if (d.valueType === 'list') {
    return draft
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return draft;
}

export function AdjustForm({
  profileId,
  dimensions,
}: {
  profileId: string;
  dimensions: AdjustDimension[];
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(dimensions.map((d) => [d.key, toDraft(d)])),
  );
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    const changed: Record<string, number | string | string[]> = {};
    for (const d of dimensions) {
      if (drafts[d.key] !== toDraft(d)) changed[d.key] = fromDraft(d, drafts[d.key] ?? '');
    }
    if (Object.keys(changed).length === 0 && !note.trim()) {
      setProblem('Change at least one value or add a note.');
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/profiles/${profileId}/adjust`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dimensions: changed, ...(note.trim() ? { note } : {}) }),
      });
      if (res.ok) {
        setNote('');
        toast.success('Adjustment saved as a new version.');
        router.refresh();
        return;
      }
      let body: ErrorBody = {};
      try {
        body = (await res.json()) as ErrorBody;
      } catch {
        // fall through to generic message
      }
      if (body.error?.code === 'sensitive_content') {
        // Field names only; submitted values are never echoed.
        const keys = Array.isArray(body.error.details?.fields)
          ? (body.error.details.fields as string[])
          : [];
        const names = keys.map((k) =>
          k === 'note' ? 'Note' : (dimensions.find((d) => d.key === k)?.name ?? k),
        );
        setProblem(
          `That value contains sensitive content and was not saved${names.length ? `: ${names.join(', ')}` : ''}.`,
        );
      } else if (body.error?.code === 'validation_failed') {
        const f = body.error.details?.field;
        const name =
          typeof f === 'string' ? (dimensions.find((d) => d.key === f)?.name ?? f) : null;
        setProblem(`Invalid value${name ? ` for ${name}` : ''}.`);
      } else {
        setProblem(body.error?.message ?? 'Something went wrong.');
      }
    } catch {
      setProblem('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  function set(key: string, v: string) {
    setDrafts((prev) => ({ ...prev, [key]: v }));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {dimensions.map((d) => {
        const id = `adjust-${d.key}`;
        return (
          <div key={d.key} className="flex flex-col gap-1">
            <Label htmlFor={id}>{d.name}</Label>
            {d.valueType === 'scale' && d.scale ? (
              <>
                <input
                  id={id}
                  type="range"
                  min={d.scale.min}
                  max={d.scale.max}
                  step={1}
                  value={drafts[d.key] ?? ''}
                  onChange={(e) => set(d.key, e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {d.scale.min}: {d.scale.minLabel}
                  </span>
                  <span>{drafts[d.key]}</span>
                  <span>
                    {d.scale.max}: {d.scale.maxLabel}
                  </span>
                </div>
              </>
            ) : d.valueType === 'enum' ? (
              <select
                id={id}
                value={drafts[d.key] ?? ''}
                onChange={(e) => set(d.key, e.target.value)}
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              >
                {(d.allowedValues ?? []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : d.valueType === 'list' ? (
              <textarea
                id={id}
                rows={3}
                value={drafts[d.key] ?? ''}
                onChange={(e) => set(d.key, e.target.value)}
                placeholder="One item per line or comma separated"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              />
            ) : (
              <Input
                id={id}
                value={drafts[d.key] ?? ''}
                maxLength={600}
                onChange={(e) => set(d.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
      <div className="flex flex-col gap-1">
        <Label htmlFor="adjust-note">Note (optional)</Label>
        <textarea
          id="adjust-note"
          rows={2}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="sm:self-start">
        Save adjustment
      </Button>
    </form>
  );
}

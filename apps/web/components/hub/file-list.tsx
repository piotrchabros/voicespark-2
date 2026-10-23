'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { labelFor, type CountCategory } from '@voicespark/filters/categories';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  EXTRACTION_REASON_TEXT,
  EXTRACTION_STATUS_LABELS,
  formatBytes,
  hubApiError,
  plural,
  type HubFileItem,
} from './labels';

const POLL_MS = 3000;
// eslint-disable-next-line no-control-regex
const NAME_BAD_RE = /[/\\\u0000-\u001f\u007f]/;

function reasonText(f: HubFileItem): string | null {
  if (!f.extractionReason) return null;
  if (f.extractionStatus === 'excluded') {
    return `The text was excluded: ${labelFor(f.extractionReason as CountCategory)}. The file is kept.`;
  }
  return EXTRACTION_REASON_TEXT[f.extractionReason] ?? null;
}

type Mode = { id: string; field: 'name' | 'description' } | null;

function FieldEditor({ file, field, onDone }: { file: HubFileItem; field: 'name' | 'description'; onDone: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState(field === 'name' ? file.name : (file.description ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputId = `hub-file-${field}-${file.id}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (field === 'name' && (!v || v.length > 255 || NAME_BAD_RE.test(v))) {
      setError('Enter 1 to 255 characters without / or \\.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/hub/files/${file.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(field === 'name' ? { name: v } : { description: v || null }),
      });
      if (!res.ok) {
        setError(await hubApiError(res));
        return;
      }
      toast.success('File updated.');
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
      <Label htmlFor={inputId}>{field === 'name' ? 'Rename to' : 'File description'}</Label>
      <div className="flex flex-wrap gap-2">
        <Input id={inputId} value={value} autoFocus className="w-72" onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" size="sm" disabled={pending}>
          Apply
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

// Files section list (US2, FR-009, FR-010): status and reason badges, rename, describe, download (owner only, served
// by the API) and removal. While a file's text is still being read, the page data is refreshed every few seconds.
export function FileList({ files }: { files: HubFileItem[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const anyPending = files.some((f) => f.extractionStatus === 'pending');

  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyPending, router]);

  async function remove(id: string) {
    setPending(true);
    try {
      const res = await fetch(`/api/hub/files/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await hubApiError(res));
        return;
      }
      toast.success('File removed.');
      setRemoving(null);
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  if (files.length === 0) return <p className="text-sm text-muted-foreground">No files yet.</p>;

  return (
    <ul className="divide-y rounded-md border" aria-label="Files">
      {files.map((f) => {
        const reason = reasonText(f);
        return (
          <li key={f.id} className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <span className="font-medium">{f.name}</span>
                {f.description ? <span className="text-sm">{f.description}</span> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
                  <Badge variant={f.extractionStatus === 'extracted' ? 'secondary' : 'outline'}>
                    {EXTRACTION_STATUS_LABELS[f.extractionStatus]}
                  </Badge>
                  {f.redactedValues > 0 ? (
                    <Badge variant="outline">{plural(f.redactedValues, 'value')} excluded</Badge>
                  ) : null}
                </div>
                {reason ? <span className="text-sm text-muted-foreground">{reason}</span> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="ghost" size="sm">
                  <a href={`/api/hub/files/${f.id}/download`} aria-label={`Download ${f.name}`}>
                    Download
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Rename ${f.name}`}
                  onClick={() => setMode({ id: f.id, field: 'name' })}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Describe ${f.name}`}
                  onClick={() => setMode({ id: f.id, field: 'description' })}
                >
                  Describe
                </Button>
                <Button variant="ghost" size="sm" aria-label={`Remove ${f.name}`} onClick={() => setRemoving(f.id)}>
                  Remove
                </Button>
              </div>
            </div>
            {mode?.id === f.id ? (
              <FieldEditor key={mode.field} file={f} field={mode.field} onDone={() => setMode(null)} />
            ) : null}
            {removing === f.id ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>Remove this file permanently?</span>
                <Button variant="destructive" size="sm" disabled={pending} onClick={() => void remove(f.id)}>
                  Remove permanently
                </Button>
                <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
                  Keep
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

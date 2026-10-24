'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { countOf, FIELD_LABELS, hubApiError, KIND_LABELS, plural, type HubKind, type MergePreview } from './labels';

const SELECT_CLASS = 'h-9 w-full rounded-md border bg-background px-2 text-sm';
const fieldNames = (fields: string[]) => fields.map((f) => FIELD_LABELS[f] ?? f).join(', ');

// FR-005: merges another record of the same kind into this one. The preview says what moves and which values win
// (this record's; its empty fields take the other record's) before the user confirms.
export function MergeDialog({
  kind,
  record,
  open,
  onOpenChange,
}: {
  kind: HubKind;
  record: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [options, setOptions] = useState<{ id: string; name: string }[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sourceName = options?.find((o) => o.id === sourceId)?.name ?? null;
  const singular = KIND_LABELS[kind].singular;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/hub/${kind}?sort=name&order=asc&limit=100`);
        if (!res.ok) throw new Error('list');
        const data = (await res.json()) as { items: { id: string; name: string }[] };
        if (!cancelled) setOptions(data.items.filter((o) => o.id !== record.id));
      } catch {
        if (!cancelled) {
          setOptions([]);
          setError('Could not load the records. Try again.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, kind, record.id]);

  // The preview of the chosen record; the select handler clears the previous one.
  useEffect(() => {
    if (!open || !sourceId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/hub/${kind}/${record.id}/merge-preview?sourceId=${encodeURIComponent(sourceId)}`);
        if (!res.ok) {
          const message = await hubApiError(res);
          if (!cancelled) setError(message);
          return;
        }
        const data = (await res.json()) as MergePreview;
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setError('Network error. Try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, kind, record.id, sourceId]);

  function changeOpen(next: boolean) {
    if (!next) {
      setSourceId('');
      setPreview(null);
      setError(null);
    }
    onOpenChange(next);
  }

  async function confirm() {
    if (!sourceId) return;
    setPending(true);
    try {
      const res = await fetch(`/api/hub/${kind}/${record.id}/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId }),
      });
      if (!res.ok) {
        setError(await hubApiError(res));
        return;
      }
      toast.success(`Merged ${sourceName ?? `the other ${singular}`} into ${record.name}.`);
      changeOpen(false);
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  const moves = preview?.moves;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge into {record.name}</DialogTitle>
          <DialogDescription>
            Pick the {singular} to merge into this one. Values on this record win; its empty fields take the other
            record&apos;s values. Addresses, notes, files, links and conversations move here, and the other record is
            removed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor="hub-merge-source">Record to merge into this one</Label>
          <select
            id="hub-merge-source"
            value={sourceId}
            disabled={options === null || pending}
            onChange={(e) => {
              setSourceId(e.target.value);
              setPreview(null);
              setError(null);
            }}
            className={SELECT_CLASS}
          >
            <option value="">
              {options === null
                ? 'Loading...'
                : options.length === 0
                  ? `No other ${KIND_LABELS[kind].plural.toLowerCase()}`
                  : `Choose a ${singular}`}
            </option>
            {(options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {moves && preview ? (
          <div className="flex flex-col gap-2 text-sm">
            <ul className="list-disc pl-5" aria-label="What the merge moves">
              {kind === 'people' ? <li>{countOf(moves.emails, 'email address', 'email addresses')}</li> : null}
              {kind === 'companies' ? <li>{plural(moves.domains, 'domain')}</li> : null}
              <li>{plural(moves.notes, 'note')}</li>
              <li>{plural(moves.files, 'file')}</li>
              <li>
                {plural(moves.links, 'link')}
                {moves.linkDuplicates > 0 ? ` (${moves.linkDuplicates} already linked here)` : ''}
              </li>
              <li>{countOf(moves.summaries, 'conversation summary', 'conversation summaries')}</li>
              <li>{countOf(moves.facts, 'email finding', 'email findings')}</li>
            </ul>
            {preview.keptValues.length > 0 ? (
              <p>
                {record.name} keeps: {fieldNames(preview.keptValues)}
              </p>
            ) : null}
            {preview.filledValues.length > 0 ? (
              <p>
                Filled from {sourceName}: {fieldNames(preview.filledValues)}
              </p>
            ) : null}
          </div>
        ) : sourceId && !error ? (
          <p className="text-muted-foreground text-sm">Checking what the merge moves...</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={pending || !preview} onClick={() => void confirm()}>
            Merge records
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

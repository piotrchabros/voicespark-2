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
import { KIND_LABELS, hubApiError, type HubKind } from './labels';

interface DeletePreview {
  notes: number;
  files: number;
  links: number;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// FR-004: shows what a deletion removes (preview counts) before the user confirms.
export function DeleteRecordDialog({
  kind,
  id,
  name,
  open,
  onOpenChange,
  onDeleted,
}: {
  kind: HubKind;
  id: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/hub/${kind}/${id}?deletePreview=1`);
        if (!res.ok) throw new Error('preview');
        const data = (await res.json()) as DeletePreview;
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, kind, id]);

  function changeOpen(next: boolean) {
    if (!next) {
      setPreview(null);
      setFailed(false);
    }
    onOpenChange(next);
  }

  async function confirm() {
    setPending(true);
    try {
      const res = await fetch(`/api/hub/${kind}/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await hubApiError(res));
        return;
      }
      toast.success(`Deleted ${KIND_LABELS[kind].singular}.`);
      changeOpen(false);
      onDeleted?.();
      router.push(`/hub/${kind}`);
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete record</DialogTitle>
          <DialogDescription>
            This permanently deletes {name} with its notes, files and links. Linked records are
            kept.
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load what will be deleted. Try again.
          </p>
        ) : preview ? (
          <ul className="list-disc pl-5 text-sm" aria-label="What will be deleted">
            <li>{count(preview.notes, 'note')}</li>
            <li>{count(preview.files, 'file')}</li>
            <li>{count(preview.links, 'link')}</li>
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Checking what will be deleted...</p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || !preview}
            onClick={() => void confirm()}
          >
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

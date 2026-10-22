'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ExclusionSummary } from '@/components/exclusion-summary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface UploadItem {
  id: string;
  kind: string;
  filename: string | null;
  status: string;
  rejectReason: string | null;
  importJobId: string | null;
  createdAt: string;
}

const REJECT_TEXT: Record<string, string> = {
  unsupported_type: 'Unsupported file type',
  too_large: 'File is too large',
  encrypted: 'Password-protected file',
  no_text: 'No readable text (scanned?)',
  corrupt: 'The file is corrupt or unreadable',
  empty: 'The file is empty',
  sensitive_content: 'Excluded: contains sensitive content',
};

const STATUS_LABEL: Record<string, string> = {
  received: 'Received',
  processing: 'Processing',
  stored: 'Stored',
  rejected: 'Rejected',
  failed: 'Failed',
};

const isActive = (s: string) => s === 'received' || s === 'processing';

export function UploadList({ initial }: { initial: UploadItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Adopt fresh server data after router.refresh() (state adjusted during render, not in an effect).
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setItems(initial);
  }

  const polling = items.some((i) => isActive(i.status));
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/uploads');
        if (res.ok) setItems(((await res.json()) as { items: UploadItem[] }).items);
      } catch {
        // retry on the next tick
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [polling]);

  async function remove(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/uploads/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Could not delete this item.');
        return;
      }
      toast.success('Deletion started.');
      setItems((prev) => prev.filter((i) => i.id !== id));
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setDeleting(null);
    }
  }

  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>;

  return (
    <ul className="flex flex-col gap-3">
      {items.map((u) => (
        <li key={u.id} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all font-medium">{u.filename ?? (u.kind === 'note' ? 'Note' : 'Untitled')}</span>
            <Badge variant={u.status === 'rejected' || u.status === 'failed' ? 'destructive' : 'secondary'}>
              {STATUS_LABEL[u.status] ?? u.status}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleString()}</p>
          {u.rejectReason ? (
            <p className="text-sm text-destructive">{REJECT_TEXT[u.rejectReason] ?? u.rejectReason}</p>
          ) : null}
          {u.status === 'failed' && !u.rejectReason ? (
            <p className="text-sm text-destructive">Processing failed.</p>
          ) : null}
          {u.importJobId && !isActive(u.status) ? (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="link"
                className="h-auto self-start p-0"
                aria-expanded={open === u.id}
                onClick={() => setOpen(open === u.id ? null : u.id)}
              >
                {open === u.id ? 'Hide exclusion summary' : 'Show exclusion summary'}
              </Button>
              {open === u.id ? <ExclusionSummary importJobId={u.importJobId} /> : null}
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={deleting === u.id}
            onClick={() => void remove(u.id)}
          >
            Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}

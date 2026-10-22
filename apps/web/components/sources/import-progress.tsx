'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatDate, importPercent } from '@/lib/format';

export interface ImportProgressData {
  id: string;
  kind: string;
  status: string;
  pauseReason: string | null;
  itemsProcessed: number;
  itemsImported: number;
  itemsExcluded: number;
  itemsFailed: number;
  totalEstimate: number | null;
  remainingEstimate: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
}

const TERMINAL = ['completed', 'failed', 'cancelled'];
const POLL_MS = 5000;

// Polls GET /api/imports/{id} every 5 s until the import reaches a terminal status (FR-013).
export function ImportProgress({ initial, onFinished }: { initial: ImportProgressData; onFinished?: () => void }) {
  const [data, setData] = useState(initial);
  const terminal = TERMINAL.includes(data.status);

  useEffect(() => {
    if (terminal) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/imports/${initial.id}`);
        if (!res.ok || cancelled) return;
        const next = (await res.json()) as ImportProgressData;
        if (cancelled) return;
        setData(next);
        if (TERMINAL.includes(next.status)) onFinished?.();
      } catch {
        // Keep the last known state; the next tick retries.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [initial.id, terminal, onFinished]);

  const percent = importPercent(data);
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={data.status === 'failed' ? 'destructive' : 'secondary'}>{data.status}</Badge>
        <span>{data.itemsProcessed} processed</span>
        <span className="text-muted-foreground">
          {data.remainingEstimate !== null ? `about ${data.remainingEstimate} remaining` : 'remaining unknown'}
        </span>
      </div>
      <Progress value={percent} aria-label="Import progress" />
      <p className="text-xs text-muted-foreground">Last activity: {formatDate(data.lastActivityAt)}</p>
    </div>
  );
}

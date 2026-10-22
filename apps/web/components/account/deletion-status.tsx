'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Written by the source and content-item delete actions; a JSON array of deletion request ids.
const STORAGE_KEY = 'vs.pendingDeletions';
const POLL_MS = 3000;

interface DeletionView {
  id: string;
  scope: string;
  status: string;
  requestedAt: string;
  dueBy: string;
  completedAt: string | null;
}

const SCOPE_LABELS: Record<string, string> = {
  account: 'Account',
  source: 'Source data',
  content_item: 'Content item',
};

const isTerminal = (status: string) => status === 'completed' || status === 'failed';

function readIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function forgetIds(ids: string[]) {
  try {
    const keep = readIds().filter((id) => !ids.includes(id));
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(keep));
  } catch {
    // Storage unavailable: nothing to prune.
  }
}

const formatTime = (iso: string) => new Date(iso).toLocaleString();

export function DeletionStatus() {
  const [requests, setRequests] = useState<DeletionView[]>([]);

  useEffect(() => {
    let pending = readIds();
    if (pending.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      const results = await Promise.all(
        pending.map(async (id) => {
          try {
            const res = await fetch(`/api/deletions/${encodeURIComponent(id)}`, {
              cache: 'no-store',
            });
            if (res.status === 404) return { id, gone: true as const };
            if (!res.ok) return { id, gone: false as const };
            return { id, gone: false as const, view: (await res.json()) as DeletionView };
          } catch {
            return { id, gone: false as const };
          }
        }),
      );
      if (cancelled) return;
      const views = results.flatMap((r) => (r.view ? [r.view] : []));
      setRequests((prev) => {
        const byId = new Map(prev.map((r) => [r.id, r]));
        for (const v of views) byId.set(v.id, v);
        return [...byId.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      });
      // Finished or unknown requests are dropped from storage; the latest view stays on screen.
      const done = [
        ...results.filter((r) => r.gone).map((r) => r.id),
        ...views.filter((v) => isTerminal(v.status)).map((v) => v.id),
      ];
      if (done.length > 0) forgetIds(done);
      pending = pending.filter((id) => !done.includes(id));
      if (pending.length > 0) timer = setTimeout(() => void poll(), POLL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (requests.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deletion requests</CardTitle>
        <CardDescription>Data deletions you requested in this browser session.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3" aria-live="polite">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{SCOPE_LABELS[r.scope] ?? r.scope}</span>
                <Badge
                  variant={
                    r.status === 'failed'
                      ? 'destructive'
                      : r.status === 'completed'
                        ? 'default'
                        : 'secondary'
                  }
                >
                  {r.status.replace('_', ' ')}
                </Badge>
              </div>
              <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt>Requested</dt>
                <dd>{formatTime(r.requestedAt)}</dd>
                <dt>Due by</dt>
                <dd>{formatTime(r.dueBy)}</dd>
                {r.completedAt ? (
                  <>
                    <dt>Completed</dt>
                    <dd>{formatTime(r.completedAt)}</dd>
                  </>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// Pure formatting helpers shared by server and client components (no 'use client').

export function importPercent(p: {
  itemsProcessed: number;
  totalEstimate: number | null;
  status: string;
}): number {
  if (p.status === 'completed') return 100;
  if (!p.totalEstimate || p.totalEstimate <= 0) return 0;
  return Math.min(100, Math.round((p.itemsProcessed / p.totalEstimate) * 100));
}

export function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

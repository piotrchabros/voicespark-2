'use client';

import { useEffect, useState } from 'react';

interface Summary {
  importJobId: string;
  categories: { key: string; label: string; excludedItems: number; redactedValues: number }[];
  skipped: { reason: string; count: number }[];
}

const SKIP_LABELS: Record<string, string> = {
  non_text_attachment: 'Attachments without readable text',
  attachment_too_large: 'Attachments that were too large',
  unreadable_attachment: 'Attachments that could not be read',
};

// Categories and counts only; excluded values are never shown (FR-020).
export function ExclusionSummary({ importJobId }: { importJobId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/imports/${importJobId}/exclusion-summary`)
      .then(async (res) => {
        if (!res.ok) throw new Error('summary_failed');
        const data = (await res.json()) as Summary;
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [importJobId]);

  if (failed) return <p className="text-sm text-muted-foreground">The exclusion summary is unavailable.</p>;
  if (!summary) return <p className="text-sm text-muted-foreground">Loading summary...</p>;
  if (summary.categories.length === 0 && summary.skipped.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing was excluded or skipped in this import.</p>;
  }
  return (
    <div className="flex flex-col gap-4 text-sm">
      {summary.categories.length > 0 ? (
        <section>
          <h3 className="mb-1 font-medium">Excluded or redacted</h3>
          <ul className="flex flex-col gap-1">
            {summary.categories.map((c) => (
              <li key={c.key} className="flex flex-wrap justify-between gap-2">
                <span>{c.label}</span>
                <span className="text-muted-foreground">
                  {c.excludedItems} {c.excludedItems === 1 ? 'item' : 'items'} excluded
                  {c.redactedValues > 0 ? `, ${c.redactedValues} values redacted` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {summary.skipped.length > 0 ? (
        <section>
          <h3 className="mb-1 font-medium">Skipped attachments</h3>
          <ul className="flex flex-col gap-1">
            {summary.skipped.map((s) => (
              <li key={s.reason} className="flex flex-wrap justify-between gap-2">
                <span>{SKIP_LABELS[s.reason] ?? s.reason}</span>
                <span className="text-muted-foreground">{s.count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

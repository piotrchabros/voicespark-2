'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { SUGGESTIONS_BADGE_POLL_MS, SUGGESTIONS_CHANGED_EVENT } from './labels';

/** The pending count, or null when the route could not be read (the last count is kept). */
async function fetchCount(): Promise<number | null> {
  try {
    const res = await fetch('/api/hub/suggestions/count', { cache: 'no-store' });
    if (!res.ok) return null;
    return ((await res.json()) as { pending: number }).pending;
  } catch {
    return null;
  }
}

// FR-024: the number of waiting suggestions next to "Suggestions" in the hub nav, so it is visible on every hub page.
// Reads the count on mount and on navigation, then polls it, and refreshes when the tab regains focus and when the
// queue page decides (window event).
export function SuggestionsBadge() {
  const pathname = usePathname();
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetchCount().then((n) => {
        if (!cancelled && n !== null) setPending(n);
      });
    };
    refresh();
    const timer = setInterval(refresh, SUGGESTIONS_BADGE_POLL_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener(SUGGESTIONS_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(SUGGESTIONS_CHANGED_EVENT, refresh);
    };
  }, [pathname]);

  if (pending === null) return null;
  return (
    <Badge
      variant={pending > 0 ? 'default' : 'secondary'}
      data-testid="suggestions-badge"
      data-pending={pending}
      title={`${pending} waiting`}
    >
      {pending}
    </Badge>
  );
}

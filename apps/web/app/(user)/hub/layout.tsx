import { Suspense, type ReactNode } from 'react';
import { HubSubNav, type HubSubNavItem } from '@/components/hub/hub-subnav';
import { HubSearchBox } from '@/components/hub/search-results';
import { SuggestionsBadge } from '@/components/hub/suggestions-badge';

export const dynamic = 'force-dynamic';

// The Suggestions badge carries the waiting count on every hub page (US4, FR-024).
const ITEMS: HubSubNavItem[] = [
  { href: '/hub/people', label: 'People' },
  { href: '/hub/companies', label: 'Companies' },
  { href: '/hub/projects', label: 'Projects' },
  { href: '/hub/suggestions', label: 'Suggestions', badge: <SuggestionsBadge /> },
  { href: '/hub/search', label: 'Search' },
  { href: '/hub/settings', label: 'Settings' },
];

export default function HubLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <HubSubNav items={ITEMS} />
        {/* useSearchParams in the box needs a boundary; the layout is dynamic, so it renders on the server anyway. */}
        <Suspense fallback={null}>
          <HubSearchBox />
        </Suspense>
      </div>
      {children}
    </div>
  );
}

import { Suspense, type ReactNode } from 'react';
import { HubSubNav, type HubSubNavItem } from '@/components/hub/hub-subnav';
import { HubSearchBox } from '@/components/hub/search-results';

export const dynamic = 'force-dynamic';

// The Suggestions badge (pending count) is filled in US4.
const ITEMS: HubSubNavItem[] = [
  { href: '/hub/people', label: 'People' },
  { href: '/hub/companies', label: 'Companies' },
  { href: '/hub/projects', label: 'Projects' },
  { href: '/hub/suggestions', label: 'Suggestions' },
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

'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface HubSubNavItem {
  href: string;
  label: string;
  /** Badge slot (filled for Suggestions in US4). */
  badge?: ReactNode;
}

export function HubSubNav({ items }: { items: HubSubNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Hub">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {items.map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <li key={l.href} className="shrink-0">
              <Link
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'hover:bg-accent flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
                  active && 'bg-accent',
                )}
              >
                {l.label}
                {l.badge}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

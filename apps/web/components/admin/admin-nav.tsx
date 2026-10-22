'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/definitions', label: 'Definitions' },
  { href: '/admin/prompts', label: 'Prompts' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/audit', label: 'Audit' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Admin"
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {LINKS.map((l) => {
          const active = l.href === '/admin' ? pathname === l.href : pathname.startsWith(l.href);
          return (
            <li key={l.href} className="shrink-0">
              <Link
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'hover:bg-accent block rounded-md px-3 py-2 text-sm font-medium',
                  active && 'bg-accent',
                )}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <Link href="/dashboard" className="text-sm underline">
        Back to app
      </Link>
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/sources', label: 'Sources' },
  { href: '/uploads', label: 'Uploads' },
  { href: '/content', label: 'Content' },
  { href: '/filters', label: 'Filters' },
  { href: '/profiles', label: 'Profiles' },
  { href: '/drafts', label: 'Drafts' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/settings', label: 'Settings' },
];

export function UserNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await authClient.signOut();
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <nav
      aria-label="Main"
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {(isAdmin ? [...LINKS, { href: '/admin', label: 'Admin' }] : LINKS).map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => void signOut()}
      >
        Sign out
      </Button>
    </nav>
  );
}

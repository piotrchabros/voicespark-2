import type { ReactNode } from 'react';
import { UserNav } from '@/components/user-nav';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function UserLayout({ children }: { children: ReactNode }) {
  const ctx = await requireUserOrRedirect();
  return (
    <div className="mx-auto min-h-screen max-w-5xl px-4 py-4">
      <header className="border-b pb-3">
        <UserNav isAdmin={ctx.role === 'admin'} />
      </header>
      <main className="py-6">{children}</main>
    </div>
  );
}

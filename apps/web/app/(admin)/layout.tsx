import type { ReactNode } from 'react';
import { AdminNav } from '@/components/admin/admin-nav';
import { Forbidden } from '@/components/admin/forbidden';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // The role is only known server-side (the proxy cannot see it): non-admins get the 403 page (D-A5).
  const ctx = await requireAdminPage();
  if (!ctx) return <Forbidden />;
  return (
    <div className="mx-auto min-h-screen max-w-5xl px-4 py-4">
      <header className="flex flex-col gap-3 border-b pb-3">
        <AdminNav />
        <p className="text-muted-foreground text-xs">Admins never see user content.</p>
      </header>
      <main className="py-6">{children}</main>
    </div>
  );
}

import * as adminSystem from '@voicespark/core/services/admin-system';
import { SettingsForm } from '@/components/admin/settings-form';
import { Forbidden } from '@/components/admin/forbidden';
import { requireAdminPage } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const admin = await requireAdminPage();
  if (!admin) return <Forbidden />;

  const settings = (await adminSystem.listSettings()).map((s) => ({
    ...s,
    updatedAt: s.updatedAt?.toISOString() ?? null,
  }));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Thresholds that apply to every user. Changes take effect on the next profile or draft
          operation and are recorded in the audit log.
        </p>
      </div>
      <SettingsForm settings={settings} />
    </div>
  );
}

import { z } from 'zod';
import { APP_SETTING_DEFAULTS } from '@voicespark/db';
import * as settings from '@voicespark/core/services/settings';
import * as adminSystem from '@voicespark/core/services/admin-system';
import { adminJson } from '@/lib/admin-schemas';
import { requireAdmin } from '@/lib/guards';
import { handle, parseJson } from '@/lib/http';

const SETTING_KEYS = Object.keys(APP_SETTING_DEFAULTS) as [
  settings.SettingKey,
  ...settings.SettingKey[],
];

const putSchema = z.strictObject({ key: z.enum(SETTING_KEYS), value: z.number() });

const view = (s: adminSystem.SettingView) => ({ ...s, updatedAt: s.updatedAt?.toISOString() ?? null });

export const GET = handle(async () => {
  await requireAdmin();
  const list = await adminSystem.listSettings();
  return adminJson('GET /api/admin/settings', { settings: list.map(view) });
});

export const PUT = handle(async (req) => {
  const admin = await requireAdmin();
  const body = await parseJson(req, putSchema);
  await settings.setSetting(body.key, body.value, admin.userId);
  const list = await adminSystem.listSettings();
  const setting = list.find((s) => s.key === body.key);
  return adminJson('PUT /api/admin/settings', { setting: setting ? view(setting) : undefined });
});

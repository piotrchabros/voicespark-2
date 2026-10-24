import { z } from 'zod';
import { APP_SETTING_DEFAULTS, appSetting, getDb, withTransaction, type DbOrTx } from '@voicespark/db';
import { eq } from 'drizzle-orm';
import { audit } from './audit';

export type SettingKey = keyof typeof APP_SETTING_DEFAULTS;
export type SettingValue<_K extends SettingKey> = number;

export const SETTING_SCHEMAS: Record<SettingKey, z.ZodType<number>> = {
  'profile.min_authored_words': z.number().int().min(1),
  'profile.significant_new_content_ratio': z.number().min(0).max(1),
  'draft.memory_context_limit': z.number().int().min(1).max(20),
  'hub.daily_thread_cap_per_user': z.number().int().min(1),
};

/** Uncached on purpose: admin changes apply to the next read (FR-029). */
export async function getSetting<K extends SettingKey>(key: K, db: DbOrTx = getDb()): Promise<SettingValue<K>> {
  const [row] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, key)).limit(1);
  if (!row) return APP_SETTING_DEFAULTS[key];
  const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
  return parsed.success ? parsed.data : APP_SETTING_DEFAULTS[key];
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValue<K>,
  adminId: string,
): Promise<void> {
  const parsed = SETTING_SCHEMAS[key].parse(value);
  await withTransaction(async (tx) => {
    await tx
      .insert(appSetting)
      .values({ key, value: parsed, updatedBy: adminId })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: parsed, updatedBy: adminId, updatedAt: new Date() } });
    await audit.record(
      { actorType: 'admin', actorUserId: adminId, action: 'settings.changed', targetType: 'setting', targetId: key, metadata: { key } },
      tx,
    );
  });
}

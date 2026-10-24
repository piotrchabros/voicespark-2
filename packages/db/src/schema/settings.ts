import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const APP_SETTING_DEFAULTS = {
  'profile.min_authored_words': 5000,
  'profile.significant_new_content_ratio': 0.25,
  'draft.memory_context_limit': 8,
  'hub.daily_thread_cap_per_user': 500,
} as const;
export type AppSettingKey = keyof typeof APP_SETTING_DEFAULTS;

export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AppSetting = typeof appSetting.$inferSelect;

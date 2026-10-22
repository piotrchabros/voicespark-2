import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { filterCategoryEnum } from './enums';

/**
 * filter_preferences (1:1 with user).
 *
 * Rules:
 * - The array always contains the 4 locked keys (`passwords`, `otp_codes`, `reset_verification_links`,
 *   `api_keys_tokens`). A request missing one gets `422 category_locked` (FR-018).
 * - Defaults: all 10 categories selected, `confirmed_at` null.
 * - No import, upload or note may start while `confirmed_at` is null (FR-061, SC-014).
 */
export const filterPreferences = pgTable('filter_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  selectedCategories: filterCategoryEnum('selected_categories').array().notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

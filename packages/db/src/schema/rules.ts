import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { contentItem } from './content';
import {
  exclusionReportStatusEnum,
  exclusionRuleTypeEnum,
  filterCategoryEnum,
  retroscanStatusEnum,
  retroscanTriggerEnum,
} from './enums';
import { connectedSource } from './sources';

/** exclusion_rule: user-defined exclusion. At most 200 per user (enforced by the service). */
export const exclusionRule = pgTable(
  'exclusion_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: exclusionRuleTypeEnum('type').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('exclusion_rule_user_type_value_uq').on(t.userId, t.type, t.value)],
);

/** exclusion_report: user report of sensitive content that slipped through (FR-022). */
export const exclusionReport = pgTable('exclusion_report', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Nulled after purge.
  contentItemId: uuid('content_item_id').references(() => contentItem.id, { onDelete: 'set null' }),
  sourceId: uuid('source_id').references(() => connectedSource.id, { onDelete: 'set null' }),
  category: filterCategoryEnum('category'),
  status: exclusionReportStatusEnum('status').notNull().default('received'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
});

/** retroscan: scan of already-imported items against a new rule or newly selected categories. */
export const retroscan = pgTable(
  'retroscan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    trigger: retroscanTriggerEnum('trigger').notNull(),
    exclusionRuleId: uuid('exclusion_rule_id').references(() => exclusionRule.id, {
      onDelete: 'set null',
    }),
    categories: filterCategoryEnum('categories')
      .array()
      .notNull()
      .default(sql`'{}'`),
    status: retroscanStatusEnum('status').notNull().default('scanning'),
    matchedCount: integer('matched_count').notNull().default(0),
    matchedItemIds: uuid('matched_item_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('retroscan_user_status_idx').on(t.userId, t.status)],
);

export type ExclusionRule = typeof exclusionRule.$inferSelect;
export type ExclusionReport = typeof exclusionReport.$inferSelect;
export type Retroscan = typeof retroscan.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { connectedSource } from './sources';
import {
  importJobKindEnum,
  importJobStatusEnum,
  importPauseReasonEnum,
  itemFailureReasonEnum,
  skipReasonEnum,
} from './enums';

export const importJob = pgTable(
  'import_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => connectedSource.id, { onDelete: 'cascade' }),
    kind: importJobKindEnum('kind').notNull(),
    status: importJobStatusEnum('status').notNull(),
    pauseReason: importPauseReasonEnum('pause_reason'),
    // The filter_preferences.version in force.
    filterPolicyVersion: integer('filter_policy_version').notNull().default(0),
    totalEstimate: integer('total_estimate'),
    itemsDiscovered: integer('items_discovered').notNull().default(0),
    itemsProcessed: integer('items_processed').notNull().default(0),
    itemsImported: integer('items_imported').notNull().default(0),
    itemsDuplicate: integer('items_duplicate').notNull().default(0),
    itemsExcluded: integer('items_excluded').notNull().default(0),
    itemsRedacted: integer('items_redacted').notNull().default(0),
    itemsSkipped: integer('items_skipped').notNull().default(0),
    itemsFailed: integer('items_failed').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    errorCode: text('error_code'),
  },
  (t) => [
    // At most one non-terminal job per source (upload jobs excluded: many may run at once).
    uniqueIndex('import_job_source_active_uq')
      .on(t.sourceId)
      .where(sql`${t.status} in ('queued','running','paused') and ${t.kind} <> 'upload'`),
  ],
);

export const importItemFailure = pgTable(
  'import_item_failure',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importJobId: uuid('import_job_id')
      .notNull()
      .references(() => importJob.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => connectedSource.id, { onDelete: 'cascade' }),
    providerRef: text('provider_ref').notNull(),
    reason: itemFailureReasonEnum('reason').notNull(),
    attempts: integer('attempts').notNull(),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('import_item_failure_source_ref_uq').on(t.sourceId, t.providerRef)],
);

/**
 * exclusion_record. `category` is a `filter_category` or an `exclusion_summary_key`
 * (`user_rule`, `inspection_failed`). Holds counts only, never values.
 */
export const exclusionRecord = pgTable(
  'exclusion_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importJobId: uuid('import_job_id')
      .notNull()
      .references(() => importJob.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    excludedItems: integer('excluded_items').notNull(),
    redactedValues: integer('redacted_values').notNull(),
  },
  (t) => [uniqueIndex('exclusion_record_job_category_uq').on(t.importJobId, t.category)],
);

export const skipRecord = pgTable(
  'skip_record',
  {
    importJobId: uuid('import_job_id')
      .notNull()
      .references(() => importJob.id, { onDelete: 'cascade' }),
    reason: skipReasonEnum('reason').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.importJobId, t.reason] })],
);

import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { authorshipEnum, contentItemStatusEnum, contentKindEnum } from './enums';
import { importJob } from './imports';
import { connectedSource } from './sources';

/** content_item (metadata only). `id` equals the Supermemory document id. */
export const contentItem = pgTable(
  'content_item',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: contentKindEnum('kind').notNull(),
    // Attachment -> email.
    parentItemId: uuid('parent_item_id').references((): AnyPgColumn => contentItem.id, {
      onDelete: 'cascade',
    }),
    authorship: authorshipEnum('authorship').notNull(),
    itemDate: timestamp('item_date', { withTimezone: true }).notNull(),
    languageCode: varchar('language_code', { length: 8 }),
    wordCount: integer('word_count').notNull(),
    // HMAC with DEDUP_HMAC_KEY.
    messageIdHash: char('message_id_hash', { length: 64 }),
    // HMAC with DEDUP_HMAC_KEY.
    contentHash: char('content_hash', { length: 64 }).notNull(),
    filterPolicyVersion: integer('filter_policy_version').notNull(),
    // Count only, never values.
    redactedValues: integer('redacted_values').notNull().default(0),
    status: contentItemStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Cross-source dedup (FR-014).
    uniqueIndex('content_item_user_message_id_hash_uq')
      .on(t.userId, t.messageIdHash)
      .where(sql`${t.messageIdHash} is not null`),
    // Dedup for uploads and notes.
    index('content_item_user_content_hash_idx').on(t.userId, t.contentHash),
    // Authored word count (FR-028, FR-029).
    index('content_item_user_authorship_idx').on(t.userId, t.authorship),
  ],
);

export const contentItemOccurrence = pgTable(
  'content_item_occurrence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contentItemId: uuid('content_item_id')
      .notNull()
      .references(() => contentItem.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => connectedSource.id, { onDelete: 'cascade' }),
    providerRef: text('provider_ref').notNull(),
    // Labels/folders, used for rules (FR-021).
    folders: text('folders').array(),
    // Drives `authorship` for mail (FR-016).
    isSent: boolean('is_sent'),
    firstSeenImportJobId: uuid('first_seen_import_job_id').references(() => importJob.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('content_item_occurrence_source_ref_uq').on(t.sourceId, t.providerRef)],
);

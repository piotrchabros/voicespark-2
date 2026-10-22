import { sql } from 'drizzle-orm';
import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { sourcePauseReasonEnum, sourceStatusEnum, sourceTypeEnum } from './enums';

/**
 * connected_source.
 *
 * Exactly one `uploads` source per user, created lazily; it is only ever `connected`.
 */
export const connectedSource = pgTable(
  'connected_source',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: sourceTypeEnum('type').notNull(),
    // Mailbox address or "Uploads & notes".
    accountLabel: text('account_label').notNull(),
    accountAddress: text('account_address'),
    status: sourceStatusEnum('status').notNull(),
    pauseReason: sourcePauseReasonEnum('pause_reason'),
    dateRangeFrom: date('date_range_from', { mode: 'string' }),
    dateRangeTo: date('date_range_to', { mode: 'string' }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    // Active occurrences, denormalized.
    itemCount: integer('item_count').notNull().default(0),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    consentTextVersion: text('consent_text_version').notNull(),
  },
  (t) => [
    // Unique (user_id, type, account_address) where status != 'disconnected' (FR-007).
    uniqueIndex('connected_source_user_type_address_active_uq')
      .on(t.userId, t.type, t.accountAddress)
      .where(sql`${t.status} != 'disconnected'`),
  ],
);

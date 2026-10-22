import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const NOTIFICATION_TYPES = [
  'source_needs_reconnection',
  'import_completed',
  'deletion_completed',
  'profile_ready',
  'profile_outdated',
  'draft_ready',
  'draft_failed',
  'generation_failed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: text('type').$type<NotificationType>().notNull(),
    // Safe ids and counts only.
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notification_user_read_created_idx').on(t.userId, t.readAt, t.createdAt),
    check(
      'notification_type_check',
      sql`${t.type} in ('source_needs_reconnection', 'import_completed', 'deletion_completed', 'profile_ready', 'profile_outdated', 'draft_ready', 'draft_failed', 'generation_failed')`,
    ),
  ],
);

export type Notification = typeof notification.$inferSelect;

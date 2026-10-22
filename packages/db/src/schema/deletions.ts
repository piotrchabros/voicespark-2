import { char, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { deletionRequestedByEnum, deletionScopeEnum, deletionStatusEnum } from './enums';

export const deletionRequest = pgTable(
  'deletion_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    // HMAC of the user id; survives the account.
    subjectRef: char('subject_ref', { length: 64 }).notNull(),
    scope: deletionScopeEnum('scope').notNull(),
    targetId: uuid('target_id'),
    status: deletionStatusEnum('status').notNull().default('pending'),
    requestedBy: deletionRequestedByEnum('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    // requested_at + 24 h, set by the service.
    dueBy: timestamp('due_by', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    supermemoryDeletedCount: integer('supermemory_deleted_count').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    notifyEmailEnc: text('notify_email_enc'),
  },
  (t) => [index('deletion_request_status_due_idx').on(t.status, t.dueBy)],
);

export type DeletionRequest = typeof deletionRequest.$inferSelect;

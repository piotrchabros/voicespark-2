import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { connectedSource } from './sources';
import { contentItem } from './content';
import { importJob } from './imports';
import {
  authorshipEnum,
  uploadKindEnum,
  uploadRejectReasonEnum,
  uploadStatusEnum,
} from './enums';

/** upload. Staged bytes live encrypted on disk (`stagingPath`) until processed. */
export const upload = pgTable(
  'upload',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => connectedSource.id, { onDelete: 'cascade' }),
    kind: uploadKindEnum('kind').notNull(),
    filename: text('filename'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    authorship: authorshipEnum('authorship').notNull().default('authored'),
    status: uploadStatusEnum('status').notNull(),
    rejectReason: uploadRejectReasonEnum('reject_reason'),
    importJobId: uuid('import_job_id').references(() => importJob.id, { onDelete: 'set null' }),
    contentItemId: uuid('content_item_id').references(() => contentItem.id, {
      onDelete: 'set null',
    }),
    stagingPath: text('staging_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('upload_user_created_idx').on(t.userId, t.createdAt),
    index('upload_status_idx').on(t.status),
  ],
);

export type Upload = typeof upload.$inferSelect;

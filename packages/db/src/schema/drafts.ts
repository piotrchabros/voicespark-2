import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { promptTemplateVersion } from './prompts';
import { toneProfile } from './profiles';
import { draftContentTypeEnum, draftRatingEnum, draftStatusEnum } from './enums';

/**
 * Generated drafts (FR-049..FR-059). Content columns are AES-GCM `user-content`. There is no
 * publish column on purpose (FR-056). Admins never read this table beyond rating metadata.
 */
export const draft = pgTable(
  'draft',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    contentType: draftContentTypeEnum('content_type').notNull(),
    // Set null when the profile is deleted: the draft is kept (D-D1).
    profileId: uuid('profile_id').references(() => toneProfile.id, { onDelete: 'set null' }),
    // Pinned at creation. No FK: versions go with their profile (D-D1).
    profileVersionId: uuid('profile_version_id').notNull(),
    promptVersionId: uuid('prompt_version_id')
      .notNull()
      .references(() => promptTemplateVersion.id),
    parentDraftId: uuid('parent_draft_id').references((): AnyPgColumn => draft.id, {
      onDelete: 'set null',
    }),
    topicEnc: text('topic_enc').notNull(),
    briefEnc: text('brief_enc').notNull(),
    feedbackEnc: text('feedback_enc'),
    generatedTextEnc: text('generated_text_enc'),
    editedTextEnc: text('edited_text_enc'),
    titleEnc: text('title_enc'),
    notesEnc: text('notes_enc'),
    truncated: boolean('truncated').notNull().default(false),
    rating: draftRatingEnum('rating'),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
    redactionsApplied: integer('redactions_applied').notNull().default(0),
    status: draftStatusEnum('status').notNull().default('queued'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('draft_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('draft_rating_idx').on(t.rating, t.ratedAt),
    index('draft_profile_idx').on(t.profileId),
  ],
);

export type Draft = typeof draft.$inferSelect;

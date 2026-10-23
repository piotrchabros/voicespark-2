import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { toneDefinition, toneDefinitionVersion } from './definitions';
import { ownAnalysisPromptVersion } from './own-prompts';
import { promptTemplateVersion } from './prompts';
import {
  analysisPromptSourceEnum,
  generationBlockReasonEnum,
  profileGenerationKindEnum,
  profileGenerationStatusEnum,
  profileOutdatedReasonEnum,
  profileRatingEnum,
  profileStatusEnum,
  profileVersionFormatEnum,
  profileVersionOriginEnum,
} from './enums';

export const userDefinitionChoice = pgTable(
  'user_definition_choice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => toneDefinition.id),
    chosenAt: timestamp('chosen_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('user_definition_choice_active_uq')
      .on(t.userId, t.definitionId)
      .where(sql`${t.removedAt} is null`),
  ],
);

export const toneProfile = pgTable(
  'tone_profile',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => toneDefinition.id),
    status: profileStatusEnum('status').notNull().default('active'),
    latestVersionId: uuid('latest_version_id').references((): AnyPgColumn => profileVersion.id, {
      onDelete: 'set null',
    }),
    outdatedReason: profileOutdatedReasonEnum('outdated_reason'),
    authoredWordsAtLatest: integer('authored_words_at_latest').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tone_profile_user_definition_uq').on(t.userId, t.definitionId)],
);

export const profileVersion = pgTable(
  'profile_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => toneProfile.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    origin: profileVersionOriginEnum('origin').notNull(),
    // Informational pointer to the version this one was derived from (no FK).
    basedOnVersionId: uuid('based_on_version_id'),
    definitionVersionId: uuid('definition_version_id')
      .notNull()
      .references(() => toneDefinitionVersion.id),
    promptVersionId: uuid('prompt_version_id').references(() => promptTemplateVersion.id),
    bodyEnc: text('body_enc').notNull(),
    feedbackEnc: text('feedback_enc'),
    languages: text('languages').array().notNull().default(sql`'{}'`),
    contributingSourceIds: uuid('contributing_source_ids').array().notNull().default(sql`'{}'`),
    contributingItemCount: integer('contributing_item_count').notNull(),
    format: profileVersionFormatEnum('format').notNull().default('structured'),
    // Null for legacy rows.
    promptSource: analysisPromptSourceEnum('prompt_source'),
    ownPromptVersionId: uuid('own_prompt_version_id').references(() => ownAnalysisPromptVersion.id, {
      onDelete: 'set null',
    }),
    rating: profileRatingEnum('rating'),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('profile_version_profile_number_uq').on(t.profileId, t.versionNumber),
    index('profile_version_rating_idx').on(t.rating, t.ratedAt),
    check(
      'profile_version_prompt_source_consistent',
      sql`${t.ownPromptVersionId} is null or ${t.promptSource} = 'own'`,
    ),
  ],
);

export const profileGeneration = pgTable(
  'profile_generation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => toneProfile.id, { onDelete: 'cascade' }),
    kind: profileGenerationKindEnum('kind').notNull(),
    status: profileGenerationStatusEnum('status').notNull().default('queued'),
    blockReason: generationBlockReasonEnum('block_reason'),
    definitionVersionId: uuid('definition_version_id')
      .notNull()
      .references(() => toneDefinitionVersion.id),
    promptVersionId: uuid('prompt_version_id')
      .notNull()
      .references(() => promptTemplateVersion.id),
    ownPromptVersionId: uuid('own_prompt_version_id').references(() => ownAnalysisPromptVersion.id, {
      onDelete: 'set null',
    }),
    feedbackEnc: text('feedback_enc'),
    errorCode: text('error_code'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    resultVersionId: uuid('result_version_id').references(() => profileVersion.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('profile_generation_profile_status_idx').on(t.profileId, t.status),
    index('profile_generation_user_requested_idx').on(t.userId, t.requestedAt),
  ],
);

export type UserDefinitionChoice = typeof userDefinitionChoice.$inferSelect;
export type ToneProfile = typeof toneProfile.$inferSelect;
export type ProfileVersion = typeof profileVersion.$inferSelect;
export type ProfileGeneration = typeof profileGeneration.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
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

/** One row per user per definition. State only; the text lives in the version table. */
export const ownAnalysisPrompt = pgTable(
  'own_analysis_prompt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => toneDefinition.id),
    inUse: boolean('in_use').notNull().default(true),
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => ownAnalysisPromptVersion.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('own_analysis_prompt_user_definition_uq').on(t.userId, t.definitionId),
    index('own_analysis_prompt_definition_in_use_idx')
      .on(t.definitionId)
      .where(sql`${t.inUse}`),
    check(
      'own_analysis_prompt_in_use_has_version',
      sql`not ${t.inUse} or ${t.currentVersionId} is not null`,
    ),
  ],
);

/** Immutable; every save inserts a row. */
export const ownAnalysisPromptVersion = pgTable(
  'own_analysis_prompt_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownPromptId: uuid('own_prompt_id')
      .notNull()
      .references(() => ownAnalysisPrompt.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    // AES-GCM user-content ciphertext (content-class).
    promptTextEnc: text('prompt_text_enc').notNull(),
    charCount: integer('char_count').notNull(),
    basedOnDefinitionVersionId: uuid('based_on_definition_version_id')
      .notNull()
      .references(() => toneDefinitionVersion.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('own_analysis_prompt_version_number_uq').on(t.ownPromptId, t.versionNumber),
    index('own_analysis_prompt_version_own_prompt_idx').on(t.ownPromptId),
    check('own_analysis_prompt_version_char_count', sql`${t.charCount} between 1 and 20000`),
  ],
);

export type OwnAnalysisPrompt = typeof ownAnalysisPrompt.$inferSelect;
export type OwnAnalysisPromptVersion = typeof ownAnalysisPromptVersion.$inferSelect;

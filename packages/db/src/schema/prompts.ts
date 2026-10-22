import { sql } from 'drizzle-orm';
import {
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
import {
  promptEffortEnum,
  versionActionEnum,
  versionEntityTypeEnum,
  versionStatusEnum,
} from './enums';

export const SYSTEM_PROMPT_KEYS = [
  'tone_profile.generate',
  'tone_profile.feedback',
  'draft.social_post',
  'draft.bio',
  'draft.short_article',
] as const;
export type SystemPromptKey = (typeof SYSTEM_PROMPT_KEYS)[number];

export const promptTemplate = pgTable(
  'prompt_template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    isSystem: boolean('is_system').notNull(),
    description: text('description').notNull(),
    // Points at prompt_template_version.id; no FK, to avoid a circular reference (the service keeps it consistent).
    activeVersionId: uuid('active_version_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'prompt_template_key_format',
      sql`${t.key} in ('tone_profile.generate', 'tone_profile.feedback', 'draft.social_post', 'draft.bio', 'draft.short_article') or ${t.key} ~ '^custom[.][a-z0-9_]{2,60}$'`,
    ),
  ],
);

export const promptTemplateVersion = pgTable(
  'prompt_template_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptTemplateId: uuid('prompt_template_id')
      .notNull()
      .references(() => promptTemplate.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    status: versionStatusEnum('status').notNull(),
    systemTemplate: text('system_template').notNull(),
    userTemplate: text('user_template').notNull(),
    // Must be in LLM_ALLOWED_MODELS: validated in the service, not in SQL.
    model: text('model').notNull(),
    effort: promptEffortEnum('effort').notNull(),
    maxTokens: integer('max_tokens').notNull(),
    changeNote: text('change_note'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('prompt_template_version_number_uq').on(t.promptTemplateId, t.versionNumber),
    uniqueIndex('prompt_template_version_one_draft_uq')
      .on(t.promptTemplateId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex('prompt_template_version_one_active_uq')
      .on(t.promptTemplateId)
      .where(sql`${t.status} = 'active'`),
    index('prompt_template_version_template_idx').on(t.promptTemplateId),
    check('prompt_template_version_max_tokens_range', sql`${t.maxTokens} between 256 and 64000`),
  ],
);

/** Append-only change history for definition and prompt versions (FR-042). */
export const versionActivation = pgTable(
  'version_activation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: versionEntityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fromVersionId: uuid('from_version_id'),
    toVersionId: uuid('to_version_id').notNull(),
    action: versionActionEnum('action').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('version_activation_entity_idx').on(t.entityType, t.entityId, t.occurredAt)],
);

export type PromptTemplate = typeof promptTemplate.$inferSelect;
export type PromptTemplateVersion = typeof promptTemplateVersion.$inferSelect;
export type VersionActivation = typeof versionActivation.$inferSelect;

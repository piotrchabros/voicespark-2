import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { DIMENSION_VALUE_TYPES, definitionAvailabilityEnum, versionStatusEnum } from './enums';

export const dimensionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().min(1),
  description: z.string().min(1),
  valueType: z.enum(DIMENSION_VALUE_TYPES),
  scale: z
    .object({
      min: z.number(),
      max: z.number(),
      minLabel: z.string(),
      maxLabel: z.string(),
    })
    .optional(),
  allowedValues: z.array(z.string()).optional(),
  guidance: z.string().optional(),
});
export type Dimension = z.infer<typeof dimensionSchema>;

/** 1-20 dimensions with unique keys (FR-038, FR-040, FR-041). */
export const dimensionsSchema = z
  .array(dimensionSchema)
  .min(1)
  .max(20)
  .refine((dims) => new Set(dims.map((d) => d.key)).size === dims.length, {
    message: 'dimension keys must be unique',
  });

export const toneDefinition = pgTable(
  'tone_definition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    availability: definitionAvailabilityEnum('availability').notNull().default('retired'),
    activeVersionId: uuid('active_version_id').references(
      (): AnyPgColumn => toneDefinitionVersion.id,
    ),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('tone_definition_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]{2,63}$'`)],
);

export const toneDefinitionVersion = pgTable(
  'tone_definition_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => toneDefinition.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    status: versionStatusEnum('status').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    dimensions: jsonb('dimensions').$type<Dimension[]>().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tone_definition_version_number_uq').on(t.definitionId, t.versionNumber),
    uniqueIndex('tone_definition_version_one_draft_uq')
      .on(t.definitionId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex('tone_definition_version_one_active_uq')
      .on(t.definitionId)
      .where(sql`${t.status} = 'active'`),
    index('tone_definition_version_definition_idx').on(t.definitionId),
    check('tone_definition_version_name_len', sql`char_length(${t.name}) between 1 and 80`),
    check(
      'tone_definition_version_description_len',
      sql`char_length(${t.description}) between 1 and 500`,
    ),
  ],
);

export type ToneDefinition = typeof toneDefinition.$inferSelect;
export type ToneDefinitionVersion = typeof toneDefinitionVersion.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { connectedSource } from './sources';
import {
  hubExtractionStatusEnum,
  hubFactBasisEnum,
  hubFactStateEnum,
  hubFactTypeEnum,
  hubLinkKindEnum,
  hubOriginEnum,
  hubProjectStatusEnum,
  hubSkipReasonEnum,
  hubSyncEntityEnum,
  hubSyncStatusEnum,
  hubThreadStatusEnum,
} from './enums';

/**
 * Context Hub (spec 003). `_enc` columns are AES-GCM `user-content`; `*_key`, `*_hash` and
 * `tokens` are per-user keyed HMACs. Every table repeats `user_id` so owner scoping needs no join.
 */

const tstz = (name: string) => timestamp(name, { withTimezone: true });
const userIdCol = () =>
  uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const hubPerson = pgTable(
  'hub_person',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    nameEnc: text('name_enc').notNull(),
    nameKey: char('name_key', { length: 64 }).notNull(),
    matchKey: char('match_key', { length: 64 }).notNull(),
    roleTitleEnc: text('role_title_enc'),
    phoneEnc: text('phone_enc'),
    descriptionEnc: text('description_enc'),
    ownerFields: text('owner_fields').array().notNull().default(sql`'{}'`),
    createdFrom: hubOriginEnum('created_from').notNull().default('user'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('hub_person_user_name_key_idx').on(t.userId, t.nameKey),
    index('hub_person_user_match_key_idx').on(t.userId, t.matchKey),
    index('hub_person_user_updated_idx').on(t.userId, t.updatedAt.desc()),
  ],
);

export const hubPersonEmail = pgTable(
  'hub_person_email',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    personId: uuid('person_id')
      .notNull()
      .references(() => hubPerson.id, { onDelete: 'cascade' }),
    addressEnc: text('address_enc').notNull(),
    addressHash: char('address_hash', { length: 64 }).notNull(),
    matchHash: char('match_hash', { length: 64 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    origin: hubOriginEnum('origin').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_person_email_user_address_uq').on(t.userId, t.addressHash),
    uniqueIndex('hub_person_email_primary_uq')
      .on(t.personId)
      .where(sql`${t.isPrimary}`),
    index('hub_person_email_user_match_hash_idx').on(t.userId, t.matchHash),
    index('hub_person_email_person_idx').on(t.personId),
  ],
);

export const hubCompany = pgTable(
  'hub_company',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    nameEnc: text('name_enc').notNull(),
    nameKey: char('name_key', { length: 64 }).notNull(),
    matchKey: char('match_key', { length: 64 }).notNull(),
    websiteEnc: text('website_enc'),
    industryEnc: text('industry_enc'),
    descriptionEnc: text('description_enc'),
    ownerFields: text('owner_fields').array().notNull().default(sql`'{}'`),
    createdFrom: hubOriginEnum('created_from').notNull().default('user'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('hub_company_user_name_key_idx').on(t.userId, t.nameKey),
    index('hub_company_user_match_key_idx').on(t.userId, t.matchKey),
    index('hub_company_user_updated_idx').on(t.userId, t.updatedAt.desc()),
  ],
);

export const hubCompanyDomain = pgTable(
  'hub_company_domain',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => hubCompany.id, { onDelete: 'cascade' }),
    domainEnc: text('domain_enc').notNull(),
    domainHash: char('domain_hash', { length: 64 }).notNull(),
    origin: hubOriginEnum('origin').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_company_domain_user_hash_uq').on(t.userId, t.domainHash),
    index('hub_company_domain_company_idx').on(t.companyId),
  ],
);

export const hubProject = pgTable(
  'hub_project',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    nameEnc: text('name_enc').notNull(),
    nameKey: char('name_key', { length: 64 }).notNull(),
    matchKey: char('match_key', { length: 64 }).notNull(),
    status: hubProjectStatusEnum('status').notNull().default('planned'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    descriptionEnc: text('description_enc'),
    ownerFields: text('owner_fields').array().notNull().default(sql`'{}'`),
    createdFrom: hubOriginEnum('created_from').notNull().default('user'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('hub_project_user_name_key_idx').on(t.userId, t.nameKey),
    index('hub_project_user_match_key_idx').on(t.userId, t.matchKey),
    index('hub_project_user_updated_idx').on(t.userId, t.updatedAt.desc()),
    check(
      'hub_project_dates_order',
      sql`${t.endDate} is null or ${t.startDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

export const hubLink = pgTable(
  'hub_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    kind: hubLinkKindEnum('kind').notNull(),
    personId: uuid('person_id').references(() => hubPerson.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => hubCompany.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => hubProject.id, { onDelete: 'cascade' }),
    roleEnc: text('role_enc'),
    roleOwnerSet: boolean('role_owner_set').notNull().default(false),
    origin: hubOriginEnum('origin').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'hub_link_kind_fks',
      sql`(${t.kind} = 'person_company' and ${t.personId} is not null and ${t.companyId} is not null and ${t.projectId} is null)
        or (${t.kind} = 'person_project' and ${t.personId} is not null and ${t.projectId} is not null and ${t.companyId} is null)
        or (${t.kind} = 'company_project' and ${t.companyId} is not null and ${t.projectId} is not null and ${t.personId} is null)`,
    ),
    uniqueIndex('hub_link_person_company_uq')
      .on(t.userId, t.personId, t.companyId)
      .where(sql`${t.kind} = 'person_company'`),
    uniqueIndex('hub_link_person_project_uq')
      .on(t.userId, t.personId, t.projectId)
      .where(sql`${t.kind} = 'person_project'`),
    uniqueIndex('hub_link_company_project_uq')
      .on(t.userId, t.companyId, t.projectId)
      .where(sql`${t.kind} = 'company_project'`),
    index('hub_link_person_idx').on(t.personId),
    index('hub_link_company_idx').on(t.companyId),
    index('hub_link_project_idx').on(t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// Notes and files
// ---------------------------------------------------------------------------

export const hubNote = pgTable(
  'hub_note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    personId: uuid('person_id').references(() => hubPerson.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => hubCompany.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => hubProject.id, { onDelete: 'cascade' }),
    titleEnc: text('title_enc').notNull(),
    bodyJsonEnc: text('body_json_enc').notNull(),
    redactedValues: integer('redacted_values').notNull().default(0),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'hub_note_one_owner',
      sql`num_nonnulls(${t.personId}, ${t.companyId}, ${t.projectId}) = 1`,
    ),
    index('hub_note_person_updated_idx').on(t.personId, t.updatedAt.desc()),
    index('hub_note_company_updated_idx').on(t.companyId, t.updatedAt.desc()),
    index('hub_note_project_updated_idx').on(t.projectId, t.updatedAt.desc()),
  ],
);

export const hubFile = pgTable(
  'hub_file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    personId: uuid('person_id').references(() => hubPerson.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => hubCompany.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => hubProject.id, { onDelete: 'cascade' }),
    nameEnc: text('name_enc').notNull(),
    descriptionEnc: text('description_enc'),
    mimeType: text('mime_type').notNull(),
    extension: text('extension').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: char('sha256', { length: 64 }).notNull(),
    storageKey: uuid('storage_key').notNull(),
    keyId: text('key_id').notNull(),
    extractionStatus: hubExtractionStatusEnum('extraction_status').notNull().default('pending'),
    extractionReason: text('extraction_reason'),
    extractedTextEnc: text('extracted_text_enc'),
    redactedValues: integer('redacted_values').notNull().default(0),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'hub_file_one_owner',
      sql`num_nonnulls(${t.personId}, ${t.companyId}, ${t.projectId}) = 1`,
    ),
    check('hub_file_size_bytes_range', sql`${t.sizeBytes} between 0 and 26214400`),
    uniqueIndex('hub_file_storage_key_uq').on(t.storageKey),
    index('hub_file_person_idx').on(t.personId),
    index('hub_file_company_idx').on(t.companyId),
    index('hub_file_project_idx').on(t.projectId),
    index('hub_file_user_extraction_status_idx').on(t.userId, t.extractionStatus),
  ],
);

// ---------------------------------------------------------------------------
// Mail threads (metadata only: no body column, SC-008)
// ---------------------------------------------------------------------------

export const hubThread = pgTable(
  'hub_thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    threadKey: char('thread_key', { length: 64 }).notNull(),
    subjectEnc: text('subject_enc'),
    participantsEnc: text('participants_enc'),
    firstMessageAt: tstz('first_message_at'),
    lastMessageAt: tstz('last_message_at'),
    messageCount: integer('message_count').notNull().default(0),
    language: text('language'),
    summaryEnc: text('summary_enc'),
    summaryVersion: integer('summary_version').notNull().default(0),
    summaryUpdatedAt: tstz('summary_updated_at'),
    status: hubThreadStatusEnum('status').notNull().default('pending'),
    skipReason: hubSkipReasonEnum('skip_reason'),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    processedVersion: bigint('processed_version', { mode: 'number' }).notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    lockedUntil: tstz('locked_until'),
    lastErrorCode: text('last_error_code'),
    processedAt: tstz('processed_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_thread_user_key_uq').on(t.userId, t.threadKey),
    check('hub_thread_language_check', sql`${t.language} in ('pl', 'en', 'other')`),
    check('hub_thread_processed_le_version', sql`${t.processedVersion} <= ${t.version}`),
    check(
      'hub_thread_skip_reason_when_skipped',
      sql`${t.skipReason} is null or ${t.status} = 'skipped'`,
    ),
    index('hub_thread_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('hub_thread_user_status_idx').on(t.userId, t.status),
  ],
);

export const hubMessage = pgTable(
  'hub_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => hubThread.id, { onDelete: 'cascade' }),
    messageIdHash: char('message_id_hash', { length: 64 }).notNull(),
    inReplyToHash: char('in_reply_to_hash', { length: 64 }),
    referencesHashes: char('references_hashes', { length: 64 })
      .array()
      .notNull()
      .default(sql`'{}'`),
    sentAt: tstz('sent_at'),
    direction: text('direction').notNull(),
    isAutomated: boolean('is_automated').notNull().default(false),
    automatedReason: text('automated_reason'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_message_user_hash_uq').on(t.userId, t.messageIdHash),
    index('hub_message_thread_idx').on(t.threadId),
    index('hub_message_user_in_reply_to_idx').on(t.userId, t.inReplyToHash),
    index('hub_message_references_gin').using('gin', t.referencesHashes),
    check('hub_message_references_max', sql`cardinality(${t.referencesHashes}) <= 50`),
    check('hub_message_direction_check', sql`${t.direction} in ('inbound', 'outbound')`),
  ],
);

export const hubMessageSource = pgTable(
  'hub_message_source',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => hubMessage.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => connectedSource.id, { onDelete: 'set null' }),
    providerRef: text('provider_ref').notNull(),
    folders: text('folders').array().notNull().default(sql`'{}'`),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_message_source_source_ref_uq').on(t.sourceId, t.providerRef),
    index('hub_message_source_message_idx').on(t.messageId),
    index('hub_message_source_source_idx').on(t.sourceId),
  ],
);

export const hubThreadSource = pgTable(
  'hub_thread_source',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => hubThread.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => connectedSource.id, { onDelete: 'set null' }),
    webLinkEnc: text('web_link_enc'),
  },
  (t) => [
    uniqueIndex('hub_thread_source_thread_source_uq')
      .on(t.threadId, t.sourceId)
      .where(sql`${t.sourceId} is not null`),
    index('hub_thread_source_source_idx').on(t.sourceId),
  ],
);

export const hubThreadRecord = pgTable(
  'hub_thread_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => hubThread.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => hubPerson.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => hubCompany.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => hubProject.id, { onDelete: 'cascade' }),
  },
  (t) => [
    check(
      'hub_thread_record_one_target',
      sql`num_nonnulls(${t.personId}, ${t.companyId}, ${t.projectId}) = 1`,
    ),
    uniqueIndex('hub_thread_record_thread_person_uq')
      .on(t.threadId, t.personId)
      .where(sql`${t.personId} is not null`),
    uniqueIndex('hub_thread_record_thread_company_uq')
      .on(t.threadId, t.companyId)
      .where(sql`${t.companyId} is not null`),
    uniqueIndex('hub_thread_record_thread_project_uq')
      .on(t.threadId, t.projectId)
      .where(sql`${t.projectId} is not null`),
  ],
);

/** Cost counters only. No content. */
export const hubLlmCall = pgTable(
  'hub_llm_call',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    threadId: uuid('thread_id').references(() => hubThread.id, { onDelete: 'set null' }),
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    stopReason: text('stop_reason'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('hub_llm_call_purpose_check', sql`${t.purpose} in ('triage', 'extract')`),
    index('hub_llm_call_user_created_idx').on(t.userId, t.createdAt),
    index('hub_llm_call_created_idx').on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Findings, markers and rules
// ---------------------------------------------------------------------------

export const hubFact = pgTable(
  'hub_fact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    threadId: uuid('thread_id').references(() => hubThread.id, { onDelete: 'set null' }),
    type: hubFactTypeEnum('type').notNull(),
    state: hubFactStateEnum('state').notNull(),
    basis: hubFactBasisEnum('basis'),
    personId: uuid('person_id').references(() => hubPerson.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => hubCompany.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => hubProject.id, { onDelete: 'set null' }),
    linkId: uuid('link_id').references(() => hubLink.id, { onDelete: 'set null' }),
    dependsOnFactId: uuid('depends_on_fact_id').references((): AnyPgColumn => hubFact.id, {
      onDelete: 'cascade',
    }),
    field: text('field'),
    valueEnc: text('value_enc'),
    previousValueEnc: text('previous_value_enc'),
    conflict: boolean('conflict').notNull().default(false),
    confidence: real('confidence').notNull(),
    evidenceEnc: text('evidence_enc'),
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    reason: text('reason'),
    policyVersion: text('policy_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    decidedAt: tstz('decided_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_fact_thread_fingerprint_uq').on(t.threadId, t.fingerprint),
    index('hub_fact_user_state_idx').on(t.userId, t.state),
    index('hub_fact_user_suggested_created_idx')
      .on(t.userId, t.createdAt)
      .where(sql`${t.state} = 'suggested'`),
    index('hub_fact_person_idx').on(t.personId),
    index('hub_fact_company_idx').on(t.companyId),
    index('hub_fact_project_idx').on(t.projectId),
    index('hub_fact_link_idx').on(t.linkId),
    index('hub_fact_user_fingerprint_idx').on(t.userId, t.fingerprint),
    index('hub_fact_depends_on_idx').on(t.dependsOnFactId),
    check('hub_fact_confidence_range', sql`${t.confidence} between 0 and 1`),
    check(
      'hub_fact_reason_check',
      sql`${t.reason} in ('low_confidence', 'conflict', 'tombstoned', 'name_only_match', 'inferred_project')`,
    ),
    check('hub_fact_reason_when_suggested', sql`${t.state} <> 'suggested' or ${t.reason} is not null`),
  ],
);

export const hubFactEvidence = pgTable(
  'hub_fact_evidence',
  {
    factId: uuid('fact_id')
      .notNull()
      .references(() => hubFact.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => hubThread.id, { onDelete: 'cascade' }),
    userId: userIdCol(),
  },
  (t) => [primaryKey({ columns: [t.factId, t.threadId] })],
);

/** Stops deleted or rejected items from coming back (FR-017). Only the HMAC of the key is stored. */
export const hubBlockMarker = pgTable(
  'hub_block_marker',
  {
    userId: userIdCol(),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    reason: text('reason').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.keyHash] }),
    check('hub_block_marker_reason_check', sql`${t.reason} in ('deleted', 'rejected')`),
  ],
);

export const hubIgnoreRule = pgTable(
  'hub_ignore_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    kind: text('kind').notNull(),
    valueEnc: text('value_enc').notNull(),
    valueHash: char('value_hash', { length: 64 }).notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_ignore_rule_user_kind_hash_uq').on(t.userId, t.kind, t.valueHash),
    check('hub_ignore_rule_kind_check', sql`${t.kind} in ('address', 'domain')`),
  ],
);

/** No FK on the ids: the merged-away row is deleted. */
export const hubMergeRedirect = pgTable(
  'hub_merge_redirect',
  {
    userId: userIdCol(),
    kind: text('kind').notNull(),
    fromId: uuid('from_id').notNull(),
    toId: uuid('to_id').notNull(),
    mergedAt: tstz('merged_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.fromId] }),
    index('hub_merge_redirect_user_kind_to_idx').on(t.userId, t.kind, t.toId),
    check('hub_merge_redirect_kind_check', sql`${t.kind} in ('person', 'company', 'project')`),
  ],
);

// ---------------------------------------------------------------------------
// Mailbox settings, blind search index, memory-store outbox
// ---------------------------------------------------------------------------

export const hubMailboxSetting = pgTable(
  'hub_mailbox_setting',
  {
    sourceId: uuid('source_id')
      .primaryKey()
      .references(() => connectedSource.id, { onDelete: 'cascade' }),
    userId: userIdCol(),
    enabled: boolean('enabled').notNull().default(false),
    consentTextVersion: text('consent_text_version'),
    enabledAt: tstz('enabled_at'),
    disabledAt: tstz('disabled_at'),
    dataChoice: text('data_choice'),
    backfillState: text('backfill_state').notNull().default('none'),
    backfillCursor: jsonb('backfill_cursor'),
    threadsProcessed: integer('threads_processed').notNull().default(0),
    threadsSkipped: integer('threads_skipped').notNull().default(0),
    threadsFailed: integer('threads_failed').notNull().default(0),
    lastRunAt: tstz('last_run_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('hub_mailbox_setting_user_idx').on(t.userId),
    index('hub_mailbox_setting_user_enabled_idx')
      .on(t.userId)
      .where(sql`${t.enabled}`),
    check('hub_mailbox_setting_data_choice_check', sql`${t.dataChoice} in ('keep', 'delete')`),
    check(
      'hub_mailbox_setting_backfill_state_check',
      sql`${t.backfillState} in ('none', 'pending', 'running', 'done')`,
    ),
  ],
);

/** Per-user blind token index (FR-011, SC-003). `item_id` has no FK: deleted with the item. */
export const hubSearchDoc = pgTable(
  'hub_search_doc',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    itemType: text('item_type').notNull(),
    itemId: uuid('item_id').notNull(),
    ownerKind: text('owner_kind'),
    ownerId: uuid('owner_id'),
    tokens: char('tokens', { length: 16 })
      .array()
      .notNull()
      .default(sql`'{}'`),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('hub_search_doc_item_uq').on(t.userId, t.itemType, t.itemId),
    index('hub_search_doc_tokens_gin').using('gin', t.tokens),
    index('hub_search_doc_user_item_type_idx').on(t.userId, t.itemType),
    check(
      'hub_search_doc_item_type_check',
      sql`${t.itemType} in ('person', 'company', 'project', 'note', 'file')`,
    ),
    check(
      'hub_search_doc_owner_kind_check',
      sql`${t.ownerKind} in ('person', 'company', 'project')`,
    ),
  ],
);

/** Outbox for the memory-store copy (FR-025, FR-026). `entity_id` has no FK. */
export const hubSyncItem = pgTable(
  'hub_sync_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: userIdCol(),
    entityType: hubSyncEntityEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    docId: text('doc_id').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    syncedVersion: bigint('synced_version', { mode: 'number' }).notNull().default(0),
    deleted: boolean('deleted').notNull().default(false),
    status: hubSyncStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    lastErrorCode: text('last_error_code'),
    lastSyncedAt: tstz('last_synced_at'),
    leaseUntil: tstz('lease_until'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hub_sync_item_doc_uq').on(t.userId, t.docId),
    check('hub_sync_item_synced_le_version', sql`${t.syncedVersion} <= ${t.version}`),
    index('hub_sync_item_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} <> 'stored' or ${t.syncedVersion} < ${t.version}`),
    index('hub_sync_item_user_status_idx').on(t.userId, t.status),
  ],
);

export type HubPerson = typeof hubPerson.$inferSelect;
export type HubPersonEmail = typeof hubPersonEmail.$inferSelect;
export type HubCompany = typeof hubCompany.$inferSelect;
export type HubCompanyDomain = typeof hubCompanyDomain.$inferSelect;
export type HubProject = typeof hubProject.$inferSelect;
export type HubLink = typeof hubLink.$inferSelect;
export type HubNote = typeof hubNote.$inferSelect;
export type HubFile = typeof hubFile.$inferSelect;
export type HubThread = typeof hubThread.$inferSelect;
export type HubMessage = typeof hubMessage.$inferSelect;
export type HubMessageSource = typeof hubMessageSource.$inferSelect;
export type HubThreadSource = typeof hubThreadSource.$inferSelect;
export type HubThreadRecord = typeof hubThreadRecord.$inferSelect;
export type HubLlmCall = typeof hubLlmCall.$inferSelect;
export type HubFact = typeof hubFact.$inferSelect;
export type HubFactEvidence = typeof hubFactEvidence.$inferSelect;
export type HubBlockMarker = typeof hubBlockMarker.$inferSelect;
export type HubIgnoreRule = typeof hubIgnoreRule.$inferSelect;
export type HubMergeRedirect = typeof hubMergeRedirect.$inferSelect;
export type HubMailboxSetting = typeof hubMailboxSetting.$inferSelect;
export type HubSearchDoc = typeof hubSearchDoc.$inferSelect;
export type HubSyncItem = typeof hubSyncItem.$inferSelect;

import { pgEnum } from 'drizzle-orm/pg-core';

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleEnum = pgEnum('user_role', USER_ROLES);

export const USER_STATUS = ['active', 'suspended', 'pending_deletion'] as const;
export type UserStatus = (typeof USER_STATUS)[number];
export const userStatusEnum = pgEnum('user_status', USER_STATUS);

export const SIGN_IN_PROVIDERS = ['google', 'apple', 'microsoft', 'facebook'] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];
export const signInProviderEnum = pgEnum('sign_in_provider', SIGN_IN_PROVIDERS);

export const FILTER_CATEGORIES = [
  'passwords',
  'otp_codes',
  'reset_verification_links',
  'api_keys_tokens',
  'payment_cards',
  'bank_accounts',
  'government_ids',
  'health',
  'special_category',
  'third_party_contacts',
] as const;
export type FilterCategory = (typeof FILTER_CATEGORIES)[number];
export const filterCategoryEnum = pgEnum('filter_category', FILTER_CATEGORIES);

export const EXCLUSION_RULE_TYPES = ['sender', 'domain', 'folder_label', 'keyword'] as const;
export type ExclusionRuleType = (typeof EXCLUSION_RULE_TYPES)[number];
export const exclusionRuleTypeEnum = pgEnum('exclusion_rule_type', EXCLUSION_RULE_TYPES);

export const SOURCE_TYPES = ['gmail', 'microsoft', 'imap', 'uploads'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const sourceTypeEnum = pgEnum('source_type', SOURCE_TYPES);

export const SOURCE_STATUS = ['connected', 'paused', 'needs_reconnection', 'disconnected'] as const;
export type SourceStatus = (typeof SOURCE_STATUS)[number];
export const sourceStatusEnum = pgEnum('source_status', SOURCE_STATUS);

export const SOURCE_PAUSE_REASONS = ['user', 'suspended'] as const;
export type SourcePauseReason = (typeof SOURCE_PAUSE_REASONS)[number];
export const sourcePauseReasonEnum = pgEnum('source_pause_reason', SOURCE_PAUSE_REASONS);

export const IMPORT_JOB_KINDS = ['initial', 'incremental', 'resync', 'upload'] as const;
export type ImportJobKind = (typeof IMPORT_JOB_KINDS)[number];
export const importJobKindEnum = pgEnum('import_job_kind', IMPORT_JOB_KINDS);

export const IMPORT_JOB_STATUS = [
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUS)[number];
export const importJobStatusEnum = pgEnum('import_job_status', IMPORT_JOB_STATUS);

export const IMPORT_PAUSE_REASONS = ['user', 'auth', 'suspended'] as const;
export type ImportPauseReason = (typeof IMPORT_PAUSE_REASONS)[number];
export const importPauseReasonEnum = pgEnum('import_pause_reason', IMPORT_PAUSE_REASONS);

export const ITEM_FAILURE_REASONS = ['inspection_failed', 'parse_failed', 'fetch_failed'] as const;
export type ItemFailureReason = (typeof ITEM_FAILURE_REASONS)[number];
export const itemFailureReasonEnum = pgEnum('item_failure_reason', ITEM_FAILURE_REASONS);

export const CONTENT_KINDS = ['email', 'attachment', 'file', 'note'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export const contentKindEnum = pgEnum('content_kind', CONTENT_KINDS);

export const AUTHORSHIPS = ['authored', 'received'] as const;
export type Authorship = (typeof AUTHORSHIPS)[number];
export const authorshipEnum = pgEnum('authorship', AUTHORSHIPS);

export const CONTENT_ITEM_STATUS = ['pending_write', 'active', 'pending_deletion'] as const;
export type ContentItemStatus = (typeof CONTENT_ITEM_STATUS)[number];
export const contentItemStatusEnum = pgEnum('content_item_status', CONTENT_ITEM_STATUS);

export const SKIP_REASONS = [
  'non_text_attachment',
  'attachment_too_large',
  'unreadable_attachment',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const skipReasonEnum = pgEnum('skip_reason', SKIP_REASONS);

export const RETROSCAN_TRIGGERS = ['rule_created', 'rule_updated', 'categories_selected'] as const;
export type RetroscanTrigger = (typeof RETROSCAN_TRIGGERS)[number];
export const retroscanTriggerEnum = pgEnum('retroscan_trigger', RETROSCAN_TRIGGERS);

export const RETROSCAN_STATUS = [
  'scanning',
  'awaiting_confirmation',
  'no_matches',
  'failed',
  'purging',
  'completed',
  'dismissed',
] as const;
export type RetroscanStatus = (typeof RETROSCAN_STATUS)[number];
export const retroscanStatusEnum = pgEnum('retroscan_status', RETROSCAN_STATUS);

export const UPLOAD_KINDS = ['file', 'note'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
export const uploadKindEnum = pgEnum('upload_kind', UPLOAD_KINDS);

export const UPLOAD_STATUS = ['received', 'processing', 'stored', 'rejected', 'failed'] as const;
export type UploadStatus = (typeof UPLOAD_STATUS)[number];
export const uploadStatusEnum = pgEnum('upload_status', UPLOAD_STATUS);

export const UPLOAD_REJECT_REASONS = [
  'unsupported_type',
  'too_large',
  'encrypted',
  'no_text',
  'corrupt',
  'empty',
  'sensitive_content',
] as const;
export type UploadRejectReason = (typeof UPLOAD_REJECT_REASONS)[number];
export const uploadRejectReasonEnum = pgEnum('upload_reject_reason', UPLOAD_REJECT_REASONS);

export const DEFINITION_AVAILABILITIES = ['available', 'retired'] as const;
export type DefinitionAvailability = (typeof DEFINITION_AVAILABILITIES)[number];
export const definitionAvailabilityEnum = pgEnum(
  'definition_availability',
  DEFINITION_AVAILABILITIES,
);

export const VERSION_STATUS = ['draft', 'active', 'superseded'] as const;
export type VersionStatus = (typeof VERSION_STATUS)[number];
export const versionStatusEnum = pgEnum('version_status', VERSION_STATUS);

export const DIMENSION_VALUE_TYPES = ['scale', 'enum', 'text', 'list'] as const;
export type DimensionValueType = (typeof DIMENSION_VALUE_TYPES)[number];
export const dimensionValueTypeEnum = pgEnum('dimension_value_type', DIMENSION_VALUE_TYPES);

export const PROFILE_STATUS = ['active', 'removed'] as const;
export type ProfileStatus = (typeof PROFILE_STATUS)[number];
export const profileStatusEnum = pgEnum('profile_status', PROFILE_STATUS);

export const PROFILE_OUTDATED_REASONS = ['sources_deleted', 'significant_new_content'] as const;
export type ProfileOutdatedReason = (typeof PROFILE_OUTDATED_REASONS)[number];
export const profileOutdatedReasonEnum = pgEnum(
  'profile_outdated_reason',
  PROFILE_OUTDATED_REASONS,
);

export const PROFILE_VERSION_ORIGINS = [
  'generated',
  'regenerated',
  'feedback',
  'manual_edit',
] as const;
export type ProfileVersionOrigin = (typeof PROFILE_VERSION_ORIGINS)[number];
export const profileVersionOriginEnum = pgEnum('profile_version_origin', PROFILE_VERSION_ORIGINS);

export const PROFILE_RATINGS = ['sounds_like_me', 'not_like_me'] as const;
export type ProfileRating = (typeof PROFILE_RATINGS)[number];
export const profileRatingEnum = pgEnum('profile_rating', PROFILE_RATINGS);

export const PROFILE_GENERATION_STATUS = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
] as const;
export type ProfileGenerationStatus = (typeof PROFILE_GENERATION_STATUS)[number];
export const profileGenerationStatusEnum = pgEnum(
  'profile_generation_status',
  PROFILE_GENERATION_STATUS,
);

export const GENERATION_BLOCK_REASONS = [
  'insufficient_content',
  'definition_retired',
  'definition_not_chosen',
] as const;
export type GenerationBlockReason = (typeof GENERATION_BLOCK_REASONS)[number];
export const generationBlockReasonEnum = pgEnum(
  'generation_block_reason',
  GENERATION_BLOCK_REASONS,
);

export const DRAFT_CONTENT_TYPES = ['social_post', 'bio', 'short_article'] as const;
export type DraftContentType = (typeof DRAFT_CONTENT_TYPES)[number];
export const draftContentTypeEnum = pgEnum('draft_content_type', DRAFT_CONTENT_TYPES);

export const DRAFT_RATINGS = ['sounds_like_me', 'not_like_me'] as const;
export type DraftRating = (typeof DRAFT_RATINGS)[number];
export const draftRatingEnum = pgEnum('draft_rating', DRAFT_RATINGS);

export const DRAFT_STATUS = ['queued', 'generating', 'ready', 'failed'] as const;
export type DraftStatus = (typeof DRAFT_STATUS)[number];
export const draftStatusEnum = pgEnum('draft_status', DRAFT_STATUS);

export const DELETION_SCOPES = [
  'content_item',
  'source',
  'account',
  'retroscan_purge',
  'exclusion_report',
  'hub_source',
] as const;
export type DeletionScope = (typeof DELETION_SCOPES)[number];
export const deletionScopeEnum = pgEnum('deletion_scope', DELETION_SCOPES);

export const DELETION_STATUS = ['pending', 'in_progress', 'completed', 'failed'] as const;
export type DeletionStatus = (typeof DELETION_STATUS)[number];
export const deletionStatusEnum = pgEnum('deletion_status', DELETION_STATUS);

export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export const auditActorTypeEnum = pgEnum('audit_actor_type', AUDIT_ACTOR_TYPES);

export const PROMPT_EFFORTS = ['low', 'medium', 'high'] as const;
export type PromptEffort = (typeof PROMPT_EFFORTS)[number];
export const promptEffortEnum = pgEnum('prompt_effort', PROMPT_EFFORTS);

export const VERSION_ENTITY_TYPES = ['definition', 'prompt'] as const;
export type VersionEntityType = (typeof VERSION_ENTITY_TYPES)[number];
export const versionEntityTypeEnum = pgEnum('version_entity_type', VERSION_ENTITY_TYPES);

export const VERSION_ACTIONS = ['publish', 'rollback'] as const;
export type VersionAction = (typeof VERSION_ACTIONS)[number];
export const versionActionEnum = pgEnum('version_action', VERSION_ACTIONS);

export const DELETION_REQUESTED_BY = ['user', 'admin', 'system'] as const;
export type DeletionRequestedBy = (typeof DELETION_REQUESTED_BY)[number];
export const deletionRequestedByEnum = pgEnum('deletion_requested_by', DELETION_REQUESTED_BY);

export const LINKED_VIA = ['signup', 'confirmed_link', 'manual_link'] as const;
export type LinkedVia = (typeof LINKED_VIA)[number];
export const linkedViaEnum = pgEnum('identity_linked_via', LINKED_VIA);

export const MAILBOX_CREDENTIAL_KINDS = ['oauth', 'imap_password'] as const;
export type MailboxCredentialKind = (typeof MAILBOX_CREDENTIAL_KINDS)[number];
export const mailboxCredentialKindEnum = pgEnum(
  'mailbox_credential_kind',
  MAILBOX_CREDENTIAL_KINDS,
);

export const IMAP_TLS_MODES = ['tls', 'starttls'] as const;
export type ImapTlsMode = (typeof IMAP_TLS_MODES)[number];
export const imapTlsModeEnum = pgEnum('imap_tls_mode', IMAP_TLS_MODES);

export const MAIL_OAUTH_PROVIDERS = ['gmail', 'microsoft'] as const;
export type MailOauthProvider = (typeof MAIL_OAUTH_PROVIDERS)[number];
export const mailOauthProviderEnum = pgEnum('mail_oauth_provider', MAIL_OAUTH_PROVIDERS);

export const EXCLUSION_REPORT_STATUS = ['received', 'purged'] as const;
export type ExclusionReportStatus = (typeof EXCLUSION_REPORT_STATUS)[number];
export const exclusionReportStatusEnum = pgEnum('exclusion_report_status', EXCLUSION_REPORT_STATUS);

export const PROFILE_GENERATION_KINDS = ['generate', 'regenerate', 'feedback'] as const;
export type ProfileGenerationKind = (typeof PROFILE_GENERATION_KINDS)[number];
export const profileGenerationKindEnum = pgEnum(
  'profile_generation_kind',
  PROFILE_GENERATION_KINDS,
);

export const PROFILE_VERSION_FORMATS = ['structured', 'document'] as const;
export type ProfileVersionFormat = (typeof PROFILE_VERSION_FORMATS)[number];
export const profileVersionFormatEnum = pgEnum('profile_version_format', PROFILE_VERSION_FORMATS);

export const ANALYSIS_PROMPT_SOURCES = ['default', 'own'] as const;
export type AnalysisPromptSource = (typeof ANALYSIS_PROMPT_SOURCES)[number];
export const analysisPromptSourceEnum = pgEnum('analysis_prompt_source', ANALYSIS_PROMPT_SOURCES);

export const HUB_ORIGINS = ['user', 'email'] as const;
export type HubOrigin = (typeof HUB_ORIGINS)[number];
export const hubOriginEnum = pgEnum('hub_origin', HUB_ORIGINS);

export const HUB_PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'completed'] as const;
export type HubProjectStatus = (typeof HUB_PROJECT_STATUSES)[number];
export const hubProjectStatusEnum = pgEnum('hub_project_status', HUB_PROJECT_STATUSES);

export const HUB_LINK_KINDS = ['person_company', 'person_project', 'company_project'] as const;
export type HubLinkKind = (typeof HUB_LINK_KINDS)[number];
export const hubLinkKindEnum = pgEnum('hub_link_kind', HUB_LINK_KINDS);

export const HUB_EXTRACTION_STATUSES = ['pending', 'extracted', 'empty', 'unsupported', 'failed', 'excluded'] as const;
export type HubExtractionStatus = (typeof HUB_EXTRACTION_STATUSES)[number];
export const hubExtractionStatusEnum = pgEnum('hub_extraction_status', HUB_EXTRACTION_STATUSES);

export const HUB_THREAD_STATUSES = ['pending', 'done', 'skipped', 'failed'] as const;
export type HubThreadStatus = (typeof HUB_THREAD_STATUSES)[number];
export const hubThreadStatusEnum = pgEnum('hub_thread_status', HUB_THREAD_STATUSES);

export const HUB_SKIP_REASONS = ['automated', 'automated_llm', 'ignored', 'owner_only', 'no_candidates', 'irrelevant', 'unavailable', 'excluded'] as const;
export type HubSkipReason = (typeof HUB_SKIP_REASONS)[number];
export const hubSkipReasonEnum = pgEnum('hub_skip_reason', HUB_SKIP_REASONS);

export const HUB_FACT_TYPES = ['person', 'person_email', 'company', 'company_domain', 'project', 'field', 'link', 'link_role'] as const;
export type HubFactType = (typeof HUB_FACT_TYPES)[number];
export const hubFactTypeEnum = pgEnum('hub_fact_type', HUB_FACT_TYPES);

export const HUB_FACT_STATES = ['applied', 'suggested', 'rejected', 'overridden', 'superseded'] as const;
export type HubFactState = (typeof HUB_FACT_STATES)[number];
export const hubFactStateEnum = pgEnum('hub_fact_state', HUB_FACT_STATES);

export const HUB_FACT_BASES = ['header', 'domain', 'signature', 'text'] as const;
export type HubFactBasis = (typeof HUB_FACT_BASES)[number];
export const hubFactBasisEnum = pgEnum('hub_fact_basis', HUB_FACT_BASES);

export const HUB_SYNC_STATUSES = ['pending', 'stored', 'failed'] as const;
export type HubSyncStatus = (typeof HUB_SYNC_STATUSES)[number];
export const hubSyncStatusEnum = pgEnum('hub_sync_status', HUB_SYNC_STATUSES);

export const HUB_SYNC_ENTITIES = ['person', 'company', 'project', 'note', 'file', 'summary'] as const;
export type HubSyncEntity = (typeof HUB_SYNC_ENTITIES)[number];
export const hubSyncEntityEnum = pgEnum('hub_sync_entity', HUB_SYNC_ENTITIES);

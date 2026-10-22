CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."authorship" AS ENUM('authored', 'received');--> statement-breakpoint
CREATE TYPE "public"."content_item_status" AS ENUM('pending_write', 'active', 'pending_deletion');--> statement-breakpoint
CREATE TYPE "public"."content_kind" AS ENUM('email', 'attachment', 'file', 'note');--> statement-breakpoint
CREATE TYPE "public"."definition_availability" AS ENUM('available', 'retired');--> statement-breakpoint
CREATE TYPE "public"."deletion_requested_by" AS ENUM('user', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."deletion_scope" AS ENUM('content_item', 'source', 'account', 'retroscan_purge', 'exclusion_report');--> statement-breakpoint
CREATE TYPE "public"."deletion_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dimension_value_type" AS ENUM('scale', 'enum', 'text', 'list');--> statement-breakpoint
CREATE TYPE "public"."draft_content_type" AS ENUM('social_post', 'bio', 'short_article');--> statement-breakpoint
CREATE TYPE "public"."draft_rating" AS ENUM('sounds_like_me', 'not_like_me');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('queued', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."exclusion_rule_type" AS ENUM('sender', 'domain', 'folder_label', 'keyword');--> statement-breakpoint
CREATE TYPE "public"."filter_category" AS ENUM('passwords', 'otp_codes', 'reset_verification_links', 'api_keys_tokens', 'payment_cards', 'bank_accounts', 'government_ids', 'health', 'special_category', 'third_party_contacts');--> statement-breakpoint
CREATE TYPE "public"."generation_block_reason" AS ENUM('insufficient_content', 'definition_retired', 'definition_not_chosen');--> statement-breakpoint
CREATE TYPE "public"."import_job_kind" AS ENUM('initial', 'incremental', 'resync', 'upload');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('queued', 'running', 'paused', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."import_pause_reason" AS ENUM('user', 'auth', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."item_failure_reason" AS ENUM('inspection_failed', 'parse_failed', 'fetch_failed');--> statement-breakpoint
CREATE TYPE "public"."profile_generation_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."profile_outdated_reason" AS ENUM('sources_deleted', 'significant_new_content');--> statement-breakpoint
CREATE TYPE "public"."profile_rating" AS ENUM('sounds_like_me', 'not_like_me');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."profile_version_origin" AS ENUM('generated', 'regenerated', 'feedback', 'manual_edit');--> statement-breakpoint
CREATE TYPE "public"."prompt_effort" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."retroscan_status" AS ENUM('scanning', 'awaiting_confirmation', 'no_matches', 'failed', 'purging', 'completed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."retroscan_trigger" AS ENUM('rule_created', 'rule_updated', 'categories_selected');--> statement-breakpoint
CREATE TYPE "public"."sign_in_provider" AS ENUM('google', 'apple', 'microsoft', 'facebook');--> statement-breakpoint
CREATE TYPE "public"."skip_reason" AS ENUM('non_text_attachment', 'attachment_too_large', 'unreadable_attachment');--> statement-breakpoint
CREATE TYPE "public"."source_pause_reason" AS ENUM('user', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('connected', 'paused', 'needs_reconnection', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('gmail', 'microsoft', 'imap', 'uploads');--> statement-breakpoint
CREATE TYPE "public"."upload_kind" AS ENUM('file', 'note');--> statement-breakpoint
CREATE TYPE "public"."upload_reject_reason" AS ENUM('unsupported_type', 'too_large', 'encrypted', 'no_text', 'corrupt', 'empty', 'sensitive_content');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('received', 'processing', 'stored', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'pending_deletion');--> statement-breakpoint
CREATE TYPE "public"."version_action" AS ENUM('publish', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."version_entity_type" AS ENUM('definition', 'prompt');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('draft', 'active', 'superseded');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_id_check" CHECK ("account"."provider_id" in ('google', 'apple', 'microsoft', 'facebook'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_by" uuid,
	"last_sign_in_at" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filter_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"selected_categories" "filter_category"[] NOT NULL,
	"confirmed_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "source_type" NOT NULL,
	"account_label" text NOT NULL,
	"account_address" text,
	"status" "source_status" NOT NULL,
	"pause_reason" "source_pause_reason",
	"date_range_from" date,
	"date_range_to" date,
	"last_sync_at" timestamp with time zone,
	"last_error_code" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"consent_text_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "content_kind" NOT NULL,
	"parent_item_id" uuid,
	"authorship" "authorship" NOT NULL,
	"item_date" timestamp with time zone NOT NULL,
	"language_code" varchar(8),
	"word_count" integer NOT NULL,
	"message_id_hash" char(64),
	"content_hash" char(64) NOT NULL,
	"filter_policy_version" integer NOT NULL,
	"redacted_values" integer DEFAULT 0 NOT NULL,
	"status" "content_item_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_item_occurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_item_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"provider_ref" text NOT NULL,
	"folders" text[],
	"is_sent" boolean,
	"first_seen_import_job_id" uuid
);
--> statement-breakpoint
CREATE TABLE "exclusion_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"excluded_items" integer NOT NULL,
	"redacted_values" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_item_failure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"provider_ref" text NOT NULL,
	"reason" "item_failure_reason" NOT NULL,
	"attempts" integer NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" "import_job_kind" NOT NULL,
	"status" "import_job_status" NOT NULL,
	"pause_reason" "import_pause_reason",
	"filter_policy_version" integer DEFAULT 0 NOT NULL,
	"total_estimate" integer,
	"items_discovered" integer DEFAULT 0 NOT NULL,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"items_imported" integer DEFAULT 0 NOT NULL,
	"items_duplicate" integer DEFAULT 0 NOT NULL,
	"items_excluded" integer DEFAULT 0 NOT NULL,
	"items_redacted" integer DEFAULT 0 NOT NULL,
	"items_skipped" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "skip_record" (
	"import_job_id" uuid NOT NULL,
	"reason" "skip_reason" NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "skip_record_import_job_id_reason_pk" PRIMARY KEY("import_job_id","reason")
);
--> statement-breakpoint
CREATE TABLE "tone_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"availability" "definition_availability" DEFAULT 'retired' NOT NULL,
	"active_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tone_definition_key_unique" UNIQUE("key"),
	CONSTRAINT "tone_definition_key_format" CHECK ("tone_definition"."key" ~ '^[a-z][a-z0-9_]{2,63}$')
);
--> statement-breakpoint
CREATE TABLE "tone_definition_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "version_status" NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"dimensions" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "tone_definition_version_name_len" CHECK (char_length("tone_definition_version"."name") between 1 and 80),
	CONSTRAINT "tone_definition_version_description_len" CHECK (char_length("tone_definition_version"."description") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "prompt_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"is_system" boolean NOT NULL,
	"description" text NOT NULL,
	"active_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_template_key_unique" UNIQUE("key"),
	CONSTRAINT "prompt_template_key_format" CHECK ("prompt_template"."key" in ('tone_profile.generate', 'tone_profile.feedback', 'draft.social_post', 'draft.bio', 'draft.short_article') or "prompt_template"."key" ~ '^custom[.][a-z0-9_]{2,60}$')
);
--> statement-breakpoint
CREATE TABLE "prompt_template_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "version_status" NOT NULL,
	"system_template" text NOT NULL,
	"user_template" text NOT NULL,
	"model" text NOT NULL,
	"effort" "prompt_effort" NOT NULL,
	"max_tokens" integer NOT NULL,
	"change_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "prompt_template_version_max_tokens_range" CHECK ("prompt_template_version"."max_tokens" between 256 and 64000)
);
--> statement-breakpoint
CREATE TABLE "version_activation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "version_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_version_id" uuid,
	"to_version_id" uuid NOT NULL,
	"action" "version_action" NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"subject_ref" char(64),
	"metadata" jsonb,
	"ip_hash" char(64)
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_type_check" CHECK ("notification"."type" in ('source_needs_reconnection', 'import_completed', 'deletion_completed', 'profile_ready', 'profile_outdated', 'draft_ready', 'draft_failed', 'generation_failed'))
);
--> statement-breakpoint
CREATE TABLE "deletion_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"subject_ref" char(64) NOT NULL,
	"scope" "deletion_scope" NOT NULL,
	"target_id" uuid,
	"status" "deletion_status" DEFAULT 'pending' NOT NULL,
	"requested_by" "deletion_requested_by" NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_by" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"supermemory_deleted_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"notify_email_enc" text
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_preferences" ADD CONSTRAINT "filter_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_source" ADD CONSTRAINT "connected_source_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_item" ADD CONSTRAINT "content_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_item" ADD CONSTRAINT "content_item_parent_item_id_content_item_id_fk" FOREIGN KEY ("parent_item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_item_occurrence" ADD CONSTRAINT "content_item_occurrence_content_item_id_content_item_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_item_occurrence" ADD CONSTRAINT "content_item_occurrence_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_item_occurrence" ADD CONSTRAINT "content_item_occurrence_first_seen_import_job_id_import_job_id_fk" FOREIGN KEY ("first_seen_import_job_id") REFERENCES "public"."import_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exclusion_record" ADD CONSTRAINT "exclusion_record_import_job_id_import_job_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exclusion_record" ADD CONSTRAINT "exclusion_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_item_failure" ADD CONSTRAINT "import_item_failure_import_job_id_import_job_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_item_failure" ADD CONSTRAINT "import_item_failure_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skip_record" ADD CONSTRAINT "skip_record_import_job_id_import_job_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tone_definition" ADD CONSTRAINT "tone_definition_active_version_id_tone_definition_version_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."tone_definition_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tone_definition_version" ADD CONSTRAINT "tone_definition_version_definition_id_tone_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."tone_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template_version" ADD CONSTRAINT "prompt_template_version_prompt_template_id_prompt_template_id_fk" FOREIGN KEY ("prompt_template_id") REFERENCES "public"."prompt_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_request" ADD CONSTRAINT "deletion_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_source_user_type_address_active_uq" ON "connected_source" USING btree ("user_id","type","account_address") WHERE "connected_source"."status" != 'disconnected';--> statement-breakpoint
CREATE UNIQUE INDEX "content_item_user_message_id_hash_uq" ON "content_item" USING btree ("user_id","message_id_hash") WHERE "content_item"."message_id_hash" is not null;--> statement-breakpoint
CREATE INDEX "content_item_user_content_hash_idx" ON "content_item" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "content_item_user_authorship_idx" ON "content_item" USING btree ("user_id","authorship");--> statement-breakpoint
CREATE UNIQUE INDEX "content_item_occurrence_source_ref_uq" ON "content_item_occurrence" USING btree ("source_id","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "exclusion_record_job_category_uq" ON "exclusion_record" USING btree ("import_job_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "import_item_failure_source_ref_uq" ON "import_item_failure" USING btree ("source_id","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "import_job_source_active_uq" ON "import_job" USING btree ("source_id") WHERE "import_job"."status" in ('queued','running','paused');--> statement-breakpoint
CREATE UNIQUE INDEX "tone_definition_version_number_uq" ON "tone_definition_version" USING btree ("definition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "tone_definition_version_one_draft_uq" ON "tone_definition_version" USING btree ("definition_id") WHERE "tone_definition_version"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "tone_definition_version_one_active_uq" ON "tone_definition_version" USING btree ("definition_id") WHERE "tone_definition_version"."status" = 'active';--> statement-breakpoint
CREATE INDEX "tone_definition_version_definition_idx" ON "tone_definition_version" USING btree ("definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_template_version_number_uq" ON "prompt_template_version" USING btree ("prompt_template_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_template_version_one_draft_uq" ON "prompt_template_version" USING btree ("prompt_template_id") WHERE "prompt_template_version"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_template_version_one_active_uq" ON "prompt_template_version" USING btree ("prompt_template_id") WHERE "prompt_template_version"."status" = 'active';--> statement-breakpoint
CREATE INDEX "prompt_template_version_template_idx" ON "prompt_template_version" USING btree ("prompt_template_id");--> statement-breakpoint
CREATE INDEX "version_activation_entity_idx" ON "version_activation" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entry_action_idx" ON "audit_log_entry" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entry_actor_idx" ON "audit_log_entry" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_entry_target_idx" ON "audit_log_entry" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "notification_user_read_created_idx" ON "notification" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "deletion_request_status_due_idx" ON "deletion_request" USING btree ("status","due_by");
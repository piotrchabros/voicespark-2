CREATE TYPE "public"."hub_extraction_status" AS ENUM('pending', 'extracted', 'empty', 'unsupported', 'failed', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."hub_fact_basis" AS ENUM('header', 'domain', 'signature', 'text');--> statement-breakpoint
CREATE TYPE "public"."hub_fact_state" AS ENUM('applied', 'suggested', 'rejected', 'overridden', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."hub_fact_type" AS ENUM('person', 'person_email', 'company', 'company_domain', 'project', 'field', 'link', 'link_role');--> statement-breakpoint
CREATE TYPE "public"."hub_link_kind" AS ENUM('person_company', 'person_project', 'company_project');--> statement-breakpoint
CREATE TYPE "public"."hub_origin" AS ENUM('user', 'email');--> statement-breakpoint
CREATE TYPE "public"."hub_project_status" AS ENUM('planned', 'active', 'on_hold', 'completed');--> statement-breakpoint
CREATE TYPE "public"."hub_skip_reason" AS ENUM('automated', 'automated_llm', 'ignored', 'owner_only', 'no_candidates', 'irrelevant', 'unavailable', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."hub_sync_entity" AS ENUM('person', 'company', 'project', 'note', 'file', 'summary');--> statement-breakpoint
CREATE TYPE "public"."hub_sync_status" AS ENUM('pending', 'stored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."hub_thread_status" AS ENUM('pending', 'done', 'skipped', 'failed');--> statement-breakpoint
ALTER TYPE "public"."deletion_scope" ADD VALUE 'hub_source';--> statement-breakpoint
CREATE TABLE "hub_block_marker" (
	"user_id" uuid NOT NULL,
	"key_hash" char(64) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_block_marker_user_id_key_hash_pk" PRIMARY KEY("user_id","key_hash"),
	CONSTRAINT "hub_block_marker_reason_check" CHECK ("hub_block_marker"."reason" in ('deleted', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "hub_company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name_enc" text NOT NULL,
	"name_key" char(64) NOT NULL,
	"match_key" char(64) NOT NULL,
	"website_enc" text,
	"industry_enc" text,
	"description_enc" text,
	"owner_fields" text[] DEFAULT '{}' NOT NULL,
	"created_from" "hub_origin" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_company_domain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"domain_enc" text NOT NULL,
	"domain_hash" char(64) NOT NULL,
	"origin" "hub_origin" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid,
	"type" "hub_fact_type" NOT NULL,
	"state" "hub_fact_state" NOT NULL,
	"basis" "hub_fact_basis",
	"person_id" uuid,
	"company_id" uuid,
	"project_id" uuid,
	"link_id" uuid,
	"depends_on_fact_id" uuid,
	"field" text,
	"value_enc" text,
	"previous_value_enc" text,
	"conflict" boolean DEFAULT false NOT NULL,
	"confidence" real NOT NULL,
	"evidence_enc" text,
	"fingerprint" char(64) NOT NULL,
	"reason" text,
	"policy_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_fact_confidence_range" CHECK ("hub_fact"."confidence" between 0 and 1),
	CONSTRAINT "hub_fact_reason_check" CHECK ("hub_fact"."reason" in ('low_confidence', 'conflict', 'tombstoned', 'name_only_match', 'inferred_project')),
	CONSTRAINT "hub_fact_reason_when_suggested" CHECK ("hub_fact"."state" <> 'suggested' or "hub_fact"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "hub_fact_evidence" (
	"fact_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "hub_fact_evidence_fact_id_thread_id_pk" PRIMARY KEY("fact_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "hub_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"project_id" uuid,
	"name_enc" text NOT NULL,
	"description_enc" text,
	"mime_type" text NOT NULL,
	"extension" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"storage_key" uuid NOT NULL,
	"key_id" text NOT NULL,
	"extraction_status" "hub_extraction_status" DEFAULT 'pending' NOT NULL,
	"extraction_reason" text,
	"extracted_text_enc" text,
	"redacted_values" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_file_one_owner" CHECK (num_nonnulls("hub_file"."person_id", "hub_file"."company_id", "hub_file"."project_id") = 1),
	CONSTRAINT "hub_file_size_bytes_range" CHECK ("hub_file"."size_bytes" between 0 and 26214400)
);
--> statement-breakpoint
CREATE TABLE "hub_ignore_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_enc" text NOT NULL,
	"value_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_ignore_rule_kind_check" CHECK ("hub_ignore_rule"."kind" in ('address', 'domain'))
);
--> statement-breakpoint
CREATE TABLE "hub_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "hub_link_kind" NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"project_id" uuid,
	"role_enc" text,
	"role_owner_set" boolean DEFAULT false NOT NULL,
	"origin" "hub_origin" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_link_kind_fks" CHECK (("hub_link"."kind" = 'person_company' and "hub_link"."person_id" is not null and "hub_link"."company_id" is not null and "hub_link"."project_id" is null)
        or ("hub_link"."kind" = 'person_project' and "hub_link"."person_id" is not null and "hub_link"."project_id" is not null and "hub_link"."company_id" is null)
        or ("hub_link"."kind" = 'company_project' and "hub_link"."company_id" is not null and "hub_link"."project_id" is not null and "hub_link"."person_id" is null))
);
--> statement-breakpoint
CREATE TABLE "hub_llm_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_llm_call_purpose_check" CHECK ("hub_llm_call"."purpose" in ('triage', 'extract'))
);
--> statement-breakpoint
CREATE TABLE "hub_mailbox_setting" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"consent_text_version" text,
	"enabled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"data_choice" text,
	"backfill_state" text DEFAULT 'none' NOT NULL,
	"backfill_cursor" jsonb,
	"threads_processed" integer DEFAULT 0 NOT NULL,
	"threads_skipped" integer DEFAULT 0 NOT NULL,
	"threads_failed" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_mailbox_setting_data_choice_check" CHECK ("hub_mailbox_setting"."data_choice" in ('keep', 'delete')),
	CONSTRAINT "hub_mailbox_setting_backfill_state_check" CHECK ("hub_mailbox_setting"."backfill_state" in ('none', 'pending', 'running', 'done'))
);
--> statement-breakpoint
CREATE TABLE "hub_merge_redirect" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_merge_redirect_user_id_kind_from_id_pk" PRIMARY KEY("user_id","kind","from_id"),
	CONSTRAINT "hub_merge_redirect_kind_check" CHECK ("hub_merge_redirect"."kind" in ('person', 'company', 'project'))
);
--> statement-breakpoint
CREATE TABLE "hub_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id_hash" char(64) NOT NULL,
	"in_reply_to_hash" char(64),
	"references_hashes" char(64)[] DEFAULT '{}' NOT NULL,
	"sent_at" timestamp with time zone,
	"direction" text NOT NULL,
	"is_automated" boolean DEFAULT false NOT NULL,
	"automated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_message_references_max" CHECK (cardinality("hub_message"."references_hashes") <= 50),
	CONSTRAINT "hub_message_direction_check" CHECK ("hub_message"."direction" in ('inbound', 'outbound'))
);
--> statement-breakpoint
CREATE TABLE "hub_message_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"source_id" uuid,
	"provider_ref" text NOT NULL,
	"folders" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"project_id" uuid,
	"title_enc" text NOT NULL,
	"body_json_enc" text NOT NULL,
	"redacted_values" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_note_one_owner" CHECK (num_nonnulls("hub_note"."person_id", "hub_note"."company_id", "hub_note"."project_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "hub_person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name_enc" text NOT NULL,
	"name_key" char(64) NOT NULL,
	"match_key" char(64) NOT NULL,
	"role_title_enc" text,
	"phone_enc" text,
	"description_enc" text,
	"owner_fields" text[] DEFAULT '{}' NOT NULL,
	"created_from" "hub_origin" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_person_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"address_enc" text NOT NULL,
	"address_hash" char(64) NOT NULL,
	"match_hash" char(64) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"origin" "hub_origin" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name_enc" text NOT NULL,
	"name_key" char(64) NOT NULL,
	"match_key" char(64) NOT NULL,
	"status" "hub_project_status" DEFAULT 'planned' NOT NULL,
	"start_date" date,
	"end_date" date,
	"description_enc" text,
	"owner_fields" text[] DEFAULT '{}' NOT NULL,
	"created_from" "hub_origin" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_project_dates_order" CHECK ("hub_project"."end_date" is null or "hub_project"."start_date" is null or "hub_project"."end_date" >= "hub_project"."start_date")
);
--> statement-breakpoint
CREATE TABLE "hub_search_doc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid NOT NULL,
	"owner_kind" text,
	"owner_id" uuid,
	"tokens" char(16)[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_search_doc_item_type_check" CHECK ("hub_search_doc"."item_type" in ('person', 'company', 'project', 'note', 'file')),
	CONSTRAINT "hub_search_doc_owner_kind_check" CHECK ("hub_search_doc"."owner_kind" in ('person', 'company', 'project'))
);
--> statement-breakpoint
CREATE TABLE "hub_sync_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" "hub_sync_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"doc_id" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"synced_version" bigint DEFAULT 0 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"status" "hub_sync_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_synced_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_sync_item_synced_le_version" CHECK ("hub_sync_item"."synced_version" <= "hub_sync_item"."version")
);
--> statement-breakpoint
CREATE TABLE "hub_thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_key" char(64) NOT NULL,
	"subject_enc" text,
	"participants_enc" text,
	"first_message_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"language" text,
	"summary_enc" text,
	"summary_version" integer DEFAULT 0 NOT NULL,
	"summary_updated_at" timestamp with time zone,
	"status" "hub_thread_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" "hub_skip_reason",
	"version" bigint DEFAULT 1 NOT NULL,
	"processed_version" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"last_error_code" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_thread_language_check" CHECK ("hub_thread"."language" in ('pl', 'en', 'other')),
	CONSTRAINT "hub_thread_processed_le_version" CHECK ("hub_thread"."processed_version" <= "hub_thread"."version"),
	CONSTRAINT "hub_thread_skip_reason_when_skipped" CHECK ("hub_thread"."skip_reason" is null or "hub_thread"."status" = 'skipped')
);
--> statement-breakpoint
CREATE TABLE "hub_thread_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"person_id" uuid,
	"company_id" uuid,
	"project_id" uuid,
	CONSTRAINT "hub_thread_record_one_target" CHECK (num_nonnulls("hub_thread_record"."person_id", "hub_thread_record"."company_id", "hub_thread_record"."project_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "hub_thread_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"source_id" uuid,
	"web_link_enc" text
);
--> statement-breakpoint
ALTER TABLE "draft" ADD COLUMN "hub_record_kind" text;--> statement-breakpoint
ALTER TABLE "draft" ADD COLUMN "hub_record_id" uuid;--> statement-breakpoint
ALTER TABLE "draft" ADD COLUMN "hub_record_label_enc" text;--> statement-breakpoint
ALTER TABLE "draft" ADD COLUMN "hub_context_status" text;--> statement-breakpoint
ALTER TABLE "hub_block_marker" ADD CONSTRAINT "hub_block_marker_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_company" ADD CONSTRAINT "hub_company_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_company_domain" ADD CONSTRAINT "hub_company_domain_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_company_domain" ADD CONSTRAINT "hub_company_domain_company_id_hub_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."hub_company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact" ADD CONSTRAINT "hub_fact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact" ADD CONSTRAINT "hub_fact_thread_id_hub_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."hub_thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact" ADD CONSTRAINT "hub_fact_person_id_hub_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hub_person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact" ADD CONSTRAINT "hub_fact_company_id_hub_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."hub_company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact" ADD CONSTRAINT "hub_fact_project_id_hub_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."hub_project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact" ADD CONSTRAINT "hub_fact_link_id_hub_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."hub_link"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact" ADD CONSTRAINT "hub_fact_depends_on_fact_id_hub_fact_id_fk" FOREIGN KEY ("depends_on_fact_id") REFERENCES "public"."hub_fact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact_evidence" ADD CONSTRAINT "hub_fact_evidence_fact_id_hub_fact_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."hub_fact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact_evidence" ADD CONSTRAINT "hub_fact_evidence_thread_id_hub_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."hub_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_fact_evidence" ADD CONSTRAINT "hub_fact_evidence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_file" ADD CONSTRAINT "hub_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_file" ADD CONSTRAINT "hub_file_person_id_hub_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hub_person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_file" ADD CONSTRAINT "hub_file_company_id_hub_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."hub_company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_file" ADD CONSTRAINT "hub_file_project_id_hub_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."hub_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_ignore_rule" ADD CONSTRAINT "hub_ignore_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_link" ADD CONSTRAINT "hub_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_link" ADD CONSTRAINT "hub_link_person_id_hub_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hub_person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_link" ADD CONSTRAINT "hub_link_company_id_hub_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."hub_company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_link" ADD CONSTRAINT "hub_link_project_id_hub_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."hub_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_llm_call" ADD CONSTRAINT "hub_llm_call_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_llm_call" ADD CONSTRAINT "hub_llm_call_thread_id_hub_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."hub_thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_mailbox_setting" ADD CONSTRAINT "hub_mailbox_setting_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_mailbox_setting" ADD CONSTRAINT "hub_mailbox_setting_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_merge_redirect" ADD CONSTRAINT "hub_merge_redirect_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_message" ADD CONSTRAINT "hub_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_message" ADD CONSTRAINT "hub_message_thread_id_hub_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."hub_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_message_source" ADD CONSTRAINT "hub_message_source_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_message_source" ADD CONSTRAINT "hub_message_source_message_id_hub_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."hub_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_message_source" ADD CONSTRAINT "hub_message_source_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_person_id_hub_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hub_person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_company_id_hub_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."hub_company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_project_id_hub_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."hub_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_person" ADD CONSTRAINT "hub_person_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_person_email" ADD CONSTRAINT "hub_person_email_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_person_email" ADD CONSTRAINT "hub_person_email_person_id_hub_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hub_person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_project" ADD CONSTRAINT "hub_project_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_search_doc" ADD CONSTRAINT "hub_search_doc_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_sync_item" ADD CONSTRAINT "hub_sync_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread" ADD CONSTRAINT "hub_thread_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_record" ADD CONSTRAINT "hub_thread_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_record" ADD CONSTRAINT "hub_thread_record_thread_id_hub_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."hub_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_record" ADD CONSTRAINT "hub_thread_record_person_id_hub_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hub_person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_record" ADD CONSTRAINT "hub_thread_record_company_id_hub_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."hub_company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_record" ADD CONSTRAINT "hub_thread_record_project_id_hub_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."hub_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_source" ADD CONSTRAINT "hub_thread_source_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_source" ADD CONSTRAINT "hub_thread_source_thread_id_hub_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."hub_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_thread_source" ADD CONSTRAINT "hub_thread_source_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_company_user_name_key_idx" ON "hub_company" USING btree ("user_id","name_key");--> statement-breakpoint
CREATE INDEX "hub_company_user_match_key_idx" ON "hub_company" USING btree ("user_id","match_key");--> statement-breakpoint
CREATE INDEX "hub_company_user_updated_idx" ON "hub_company" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "hub_company_domain_user_hash_uq" ON "hub_company_domain" USING btree ("user_id","domain_hash");--> statement-breakpoint
CREATE INDEX "hub_company_domain_company_idx" ON "hub_company_domain" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_fact_thread_fingerprint_uq" ON "hub_fact" USING btree ("thread_id","fingerprint");--> statement-breakpoint
CREATE INDEX "hub_fact_user_state_idx" ON "hub_fact" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "hub_fact_user_suggested_created_idx" ON "hub_fact" USING btree ("user_id","created_at") WHERE "hub_fact"."state" = 'suggested';--> statement-breakpoint
CREATE INDEX "hub_fact_person_idx" ON "hub_fact" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "hub_fact_company_idx" ON "hub_fact" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "hub_fact_project_idx" ON "hub_fact" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hub_fact_link_idx" ON "hub_fact" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "hub_fact_user_fingerprint_idx" ON "hub_fact" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "hub_fact_depends_on_idx" ON "hub_fact" USING btree ("depends_on_fact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_file_storage_key_uq" ON "hub_file" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "hub_file_person_idx" ON "hub_file" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "hub_file_company_idx" ON "hub_file" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "hub_file_project_idx" ON "hub_file" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hub_file_user_extraction_status_idx" ON "hub_file" USING btree ("user_id","extraction_status");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_ignore_rule_user_kind_hash_uq" ON "hub_ignore_rule" USING btree ("user_id","kind","value_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_link_person_company_uq" ON "hub_link" USING btree ("user_id","person_id","company_id") WHERE "hub_link"."kind" = 'person_company';--> statement-breakpoint
CREATE UNIQUE INDEX "hub_link_person_project_uq" ON "hub_link" USING btree ("user_id","person_id","project_id") WHERE "hub_link"."kind" = 'person_project';--> statement-breakpoint
CREATE UNIQUE INDEX "hub_link_company_project_uq" ON "hub_link" USING btree ("user_id","company_id","project_id") WHERE "hub_link"."kind" = 'company_project';--> statement-breakpoint
CREATE INDEX "hub_link_person_idx" ON "hub_link" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "hub_link_company_idx" ON "hub_link" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "hub_link_project_idx" ON "hub_link" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hub_llm_call_user_created_idx" ON "hub_llm_call" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "hub_llm_call_created_idx" ON "hub_llm_call" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "hub_mailbox_setting_user_idx" ON "hub_mailbox_setting" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "hub_mailbox_setting_user_enabled_idx" ON "hub_mailbox_setting" USING btree ("user_id") WHERE "hub_mailbox_setting"."enabled";--> statement-breakpoint
CREATE INDEX "hub_merge_redirect_user_kind_to_idx" ON "hub_merge_redirect" USING btree ("user_id","kind","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_message_user_hash_uq" ON "hub_message" USING btree ("user_id","message_id_hash");--> statement-breakpoint
CREATE INDEX "hub_message_thread_idx" ON "hub_message" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "hub_message_user_in_reply_to_idx" ON "hub_message" USING btree ("user_id","in_reply_to_hash");--> statement-breakpoint
CREATE INDEX "hub_message_references_gin" ON "hub_message" USING gin ("references_hashes");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_message_source_source_ref_uq" ON "hub_message_source" USING btree ("source_id","provider_ref");--> statement-breakpoint
CREATE INDEX "hub_message_source_message_idx" ON "hub_message_source" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "hub_message_source_source_idx" ON "hub_message_source" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "hub_note_person_updated_idx" ON "hub_note" USING btree ("person_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "hub_note_company_updated_idx" ON "hub_note" USING btree ("company_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "hub_note_project_updated_idx" ON "hub_note" USING btree ("project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "hub_person_user_name_key_idx" ON "hub_person" USING btree ("user_id","name_key");--> statement-breakpoint
CREATE INDEX "hub_person_user_match_key_idx" ON "hub_person" USING btree ("user_id","match_key");--> statement-breakpoint
CREATE INDEX "hub_person_user_updated_idx" ON "hub_person" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "hub_person_email_user_address_uq" ON "hub_person_email" USING btree ("user_id","address_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_person_email_primary_uq" ON "hub_person_email" USING btree ("person_id") WHERE "hub_person_email"."is_primary";--> statement-breakpoint
CREATE INDEX "hub_person_email_user_match_hash_idx" ON "hub_person_email" USING btree ("user_id","match_hash");--> statement-breakpoint
CREATE INDEX "hub_person_email_person_idx" ON "hub_person_email" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "hub_project_user_name_key_idx" ON "hub_project" USING btree ("user_id","name_key");--> statement-breakpoint
CREATE INDEX "hub_project_user_match_key_idx" ON "hub_project" USING btree ("user_id","match_key");--> statement-breakpoint
CREATE INDEX "hub_project_user_updated_idx" ON "hub_project" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "hub_search_doc_item_uq" ON "hub_search_doc" USING btree ("user_id","item_type","item_id");--> statement-breakpoint
CREATE INDEX "hub_search_doc_tokens_gin" ON "hub_search_doc" USING gin ("tokens");--> statement-breakpoint
CREATE INDEX "hub_search_doc_user_item_type_idx" ON "hub_search_doc" USING btree ("user_id","item_type");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_sync_item_doc_uq" ON "hub_sync_item" USING btree ("user_id","doc_id");--> statement-breakpoint
CREATE INDEX "hub_sync_item_due_idx" ON "hub_sync_item" USING btree ("next_attempt_at") WHERE "hub_sync_item"."status" <> 'stored' or "hub_sync_item"."synced_version" < "hub_sync_item"."version";--> statement-breakpoint
CREATE INDEX "hub_sync_item_user_status_idx" ON "hub_sync_item" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_thread_user_key_uq" ON "hub_thread" USING btree ("user_id","thread_key");--> statement-breakpoint
CREATE INDEX "hub_thread_due_idx" ON "hub_thread" USING btree ("next_attempt_at") WHERE "hub_thread"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "hub_thread_user_status_idx" ON "hub_thread" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_thread_record_thread_person_uq" ON "hub_thread_record" USING btree ("thread_id","person_id") WHERE "hub_thread_record"."person_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_thread_record_thread_company_uq" ON "hub_thread_record" USING btree ("thread_id","company_id") WHERE "hub_thread_record"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_thread_record_thread_project_uq" ON "hub_thread_record" USING btree ("thread_id","project_id") WHERE "hub_thread_record"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_thread_source_thread_source_uq" ON "hub_thread_source" USING btree ("thread_id","source_id") WHERE "hub_thread_source"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "hub_thread_source_source_idx" ON "hub_thread_source" USING btree ("source_id");--> statement-breakpoint
ALTER TABLE "draft" ADD CONSTRAINT "draft_hub_record_kind_check" CHECK ("draft"."hub_record_kind" in ('person', 'company', 'project'));--> statement-breakpoint
ALTER TABLE "draft" ADD CONSTRAINT "draft_hub_record_all_or_none" CHECK (("draft"."hub_record_kind" is null and "draft"."hub_record_id" is null and "draft"."hub_record_label_enc" is null)
        or ("draft"."hub_record_kind" is not null and "draft"."hub_record_id" is not null and "draft"."hub_record_label_enc" is not null));--> statement-breakpoint
ALTER TABLE "draft" ADD CONSTRAINT "draft_hub_context_status_check" CHECK ("draft"."hub_context_status" in ('used', 'missing', 'inspection_failed'));
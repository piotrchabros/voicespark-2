-- 1. Enums
CREATE TYPE "public"."profile_version_format" AS ENUM('structured', 'document');
--> statement-breakpoint
CREATE TYPE "public"."analysis_prompt_source" AS ENUM('default', 'own');
--> statement-breakpoint
-- 2. tone_definition_version: admin-owned analysis prompt
ALTER TABLE "tone_definition_version" ADD COLUMN "analysis_prompt" text;
--> statement-breakpoint
ALTER TABLE "tone_definition_version" ADD CONSTRAINT "tone_definition_version_analysis_prompt_len" CHECK ("tone_definition_version"."analysis_prompt" is null or char_length("tone_definition_version"."analysis_prompt") <= 20000);
--> statement-breakpoint
ALTER TABLE "tone_definition_version" ALTER COLUMN "dimensions" SET DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- 3. Own analysis prompt tables, FKs and indexes
CREATE TABLE "own_analysis_prompt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"in_use" boolean DEFAULT true NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "own_analysis_prompt_in_use_has_version" CHECK (not "own_analysis_prompt"."in_use" or "own_analysis_prompt"."current_version_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "own_analysis_prompt_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"own_prompt_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"prompt_text_enc" text NOT NULL,
	"char_count" integer NOT NULL,
	"based_on_definition_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "own_analysis_prompt_version_char_count" CHECK ("own_analysis_prompt_version"."char_count" between 1 and 20000)
);
--> statement-breakpoint
ALTER TABLE "own_analysis_prompt" ADD CONSTRAINT "own_analysis_prompt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "own_analysis_prompt" ADD CONSTRAINT "own_analysis_prompt_definition_id_tone_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."tone_definition"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "own_analysis_prompt_version" ADD CONSTRAINT "own_analysis_prompt_version_own_prompt_id_own_analysis_prompt_id_fk" FOREIGN KEY ("own_prompt_id") REFERENCES "public"."own_analysis_prompt"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "own_analysis_prompt_version" ADD CONSTRAINT "own_analysis_prompt_version_based_on_definition_version_id_tone_definition_version_id_fk" FOREIGN KEY ("based_on_definition_version_id") REFERENCES "public"."tone_definition_version"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "own_analysis_prompt_user_definition_uq" ON "own_analysis_prompt" USING btree ("user_id","definition_id");
--> statement-breakpoint
CREATE INDEX "own_analysis_prompt_definition_in_use_idx" ON "own_analysis_prompt" USING btree ("definition_id") WHERE "own_analysis_prompt"."in_use";
--> statement-breakpoint
CREATE UNIQUE INDEX "own_analysis_prompt_version_number_uq" ON "own_analysis_prompt_version" USING btree ("own_prompt_id","version_number");
--> statement-breakpoint
CREATE INDEX "own_analysis_prompt_version_own_prompt_idx" ON "own_analysis_prompt_version" USING btree ("own_prompt_id");
--> statement-breakpoint
-- Circular FK, added last: both tables now exist
ALTER TABLE "own_analysis_prompt" ADD CONSTRAINT "own_analysis_prompt_current_version_id_own_analysis_prompt_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."own_analysis_prompt_version"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- 4. profile_version: format, prompt source and own prompt pin
ALTER TABLE "profile_version" ADD COLUMN "format" "profile_version_format" DEFAULT 'structured' NOT NULL;
--> statement-breakpoint
ALTER TABLE "profile_version" ADD COLUMN "prompt_source" "analysis_prompt_source";
--> statement-breakpoint
ALTER TABLE "profile_version" ADD COLUMN "own_prompt_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_own_prompt_version_id_own_analysis_prompt_version_id_fk" FOREIGN KEY ("own_prompt_version_id") REFERENCES "public"."own_analysis_prompt_version"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_prompt_source_consistent" CHECK ("profile_version"."own_prompt_version_id" is null or "profile_version"."prompt_source" = 'own');
--> statement-breakpoint
-- 5. profile_generation: own prompt pin
ALTER TABLE "profile_generation" ADD COLUMN "own_prompt_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "profile_generation" ADD CONSTRAINT "profile_generation_own_prompt_version_id_own_analysis_prompt_version_id_fk" FOREIGN KEY ("own_prompt_version_id") REFERENCES "public"."own_analysis_prompt_version"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- 6. notification: allow analysis_prompt_default_changed
ALTER TABLE "notification" DROP CONSTRAINT "notification_type_check";
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_type_check" CHECK ("notification"."type" in ('source_needs_reconnection', 'import_completed', 'deletion_completed', 'profile_ready', 'profile_outdated', 'draft_ready', 'draft_failed', 'generation_failed', 'analysis_prompt_default_changed'));

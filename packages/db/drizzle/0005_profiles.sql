CREATE TYPE "public"."profile_generation_kind" AS ENUM('generate', 'regenerate', 'feedback');--> statement-breakpoint
CREATE TABLE "profile_generation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" "profile_generation_kind" NOT NULL,
	"status" "profile_generation_status" DEFAULT 'queued' NOT NULL,
	"block_reason" "generation_block_reason",
	"definition_version_id" uuid NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"feedback_enc" text,
	"error_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result_version_id" uuid
);
--> statement-breakpoint
CREATE TABLE "profile_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"origin" "profile_version_origin" NOT NULL,
	"based_on_version_id" uuid,
	"definition_version_id" uuid NOT NULL,
	"prompt_version_id" uuid,
	"body_enc" text NOT NULL,
	"feedback_enc" text,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"contributing_source_ids" uuid[] DEFAULT '{}' NOT NULL,
	"contributing_item_count" integer NOT NULL,
	"rating" "profile_rating",
	"rated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tone_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"status" "profile_status" DEFAULT 'active' NOT NULL,
	"latest_version_id" uuid,
	"outdated_reason" "profile_outdated_reason",
	"authored_words_at_latest" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_definition_choice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"chosen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "profile_generation" ADD CONSTRAINT "profile_generation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_generation" ADD CONSTRAINT "profile_generation_profile_id_tone_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tone_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_generation" ADD CONSTRAINT "profile_generation_definition_version_id_tone_definition_version_id_fk" FOREIGN KEY ("definition_version_id") REFERENCES "public"."tone_definition_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_generation" ADD CONSTRAINT "profile_generation_prompt_version_id_prompt_template_version_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_template_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_generation" ADD CONSTRAINT "profile_generation_result_version_id_profile_version_id_fk" FOREIGN KEY ("result_version_id") REFERENCES "public"."profile_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_profile_id_tone_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tone_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_definition_version_id_tone_definition_version_id_fk" FOREIGN KEY ("definition_version_id") REFERENCES "public"."tone_definition_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_prompt_version_id_prompt_template_version_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_template_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tone_profile" ADD CONSTRAINT "tone_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tone_profile" ADD CONSTRAINT "tone_profile_definition_id_tone_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."tone_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tone_profile" ADD CONSTRAINT "tone_profile_latest_version_id_profile_version_id_fk" FOREIGN KEY ("latest_version_id") REFERENCES "public"."profile_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_definition_choice" ADD CONSTRAINT "user_definition_choice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_definition_choice" ADD CONSTRAINT "user_definition_choice_definition_id_tone_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."tone_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_generation_profile_status_idx" ON "profile_generation" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "profile_generation_user_requested_idx" ON "profile_generation" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_version_profile_number_uq" ON "profile_version" USING btree ("profile_id","version_number");--> statement-breakpoint
CREATE INDEX "profile_version_rating_idx" ON "profile_version" USING btree ("rating","rated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tone_profile_user_definition_uq" ON "tone_profile" USING btree ("user_id","definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_definition_choice_active_uq" ON "user_definition_choice" USING btree ("user_id","definition_id") WHERE "user_definition_choice"."removed_at" is null;
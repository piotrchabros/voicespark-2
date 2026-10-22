CREATE TABLE "draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"content_type" "draft_content_type" NOT NULL,
	"profile_id" uuid,
	"profile_version_id" uuid NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"parent_draft_id" uuid,
	"topic_enc" text NOT NULL,
	"brief_enc" text NOT NULL,
	"feedback_enc" text,
	"generated_text_enc" text,
	"edited_text_enc" text,
	"title_enc" text,
	"notes_enc" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"rating" "draft_rating",
	"rated_at" timestamp with time zone,
	"redactions_applied" integer DEFAULT 0 NOT NULL,
	"status" "draft_status" DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "draft" ADD CONSTRAINT "draft_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft" ADD CONSTRAINT "draft_profile_id_tone_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."tone_profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft" ADD CONSTRAINT "draft_prompt_version_id_prompt_template_version_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_template_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft" ADD CONSTRAINT "draft_parent_draft_id_draft_id_fk" FOREIGN KEY ("parent_draft_id") REFERENCES "public"."draft"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_user_created_idx" ON "draft" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "draft_rating_idx" ON "draft" USING btree ("rating","rated_at");--> statement-breakpoint
CREATE INDEX "draft_profile_idx" ON "draft" USING btree ("profile_id");
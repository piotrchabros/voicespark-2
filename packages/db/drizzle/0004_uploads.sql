CREATE TABLE "upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" "upload_kind" NOT NULL,
	"filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"authorship" "authorship" DEFAULT 'authored' NOT NULL,
	"status" "upload_status" NOT NULL,
	"reject_reason" "upload_reject_reason",
	"import_job_id" uuid,
	"content_item_id" uuid,
	"staging_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "import_job_source_active_uq";--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_import_job_id_import_job_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_content_item_id_content_item_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_user_created_idx" ON "upload" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "upload_status_idx" ON "upload" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_job_source_active_uq" ON "import_job" USING btree ("source_id") WHERE "import_job"."status" in ('queued','running','paused') and "import_job"."kind" <> 'upload';
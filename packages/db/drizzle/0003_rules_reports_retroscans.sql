CREATE TYPE "public"."exclusion_report_status" AS ENUM('received', 'purged');--> statement-breakpoint
CREATE TABLE "exclusion_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"content_item_id" uuid,
	"source_id" uuid,
	"category" "filter_category",
	"status" "exclusion_report_status" DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exclusion_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "exclusion_rule_type" NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retroscan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger" "retroscan_trigger" NOT NULL,
	"exclusion_rule_id" uuid,
	"categories" "filter_category"[] DEFAULT '{}' NOT NULL,
	"status" "retroscan_status" DEFAULT 'scanning' NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"matched_item_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exclusion_report" ADD CONSTRAINT "exclusion_report_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exclusion_report" ADD CONSTRAINT "exclusion_report_content_item_id_content_item_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exclusion_report" ADD CONSTRAINT "exclusion_report_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exclusion_rule" ADD CONSTRAINT "exclusion_rule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retroscan" ADD CONSTRAINT "retroscan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retroscan" ADD CONSTRAINT "retroscan_exclusion_rule_id_exclusion_rule_id_fk" FOREIGN KEY ("exclusion_rule_id") REFERENCES "public"."exclusion_rule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exclusion_rule_user_type_value_uq" ON "exclusion_rule" USING btree ("user_id","type","value");--> statement-breakpoint
CREATE INDEX "retroscan_user_status_idx" ON "retroscan" USING btree ("user_id","status");
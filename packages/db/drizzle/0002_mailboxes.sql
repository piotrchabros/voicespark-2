CREATE TYPE "public"."imap_tls_mode" AS ENUM('tls', 'starttls');--> statement-breakpoint
CREATE TYPE "public"."mail_oauth_provider" AS ENUM('gmail', 'microsoft');--> statement-breakpoint
CREATE TYPE "public"."mailbox_credential_kind" AS ENUM('oauth', 'imap_password');--> statement-breakpoint
CREATE TABLE "mailbox_credential" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"kind" "mailbox_credential_kind" NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"granted_scopes" text[] DEFAULT '{}' NOT NULL,
	"imap_host" text,
	"imap_port" integer,
	"imap_tls_mode" "imap_tls_mode",
	"imap_username" text,
	"imap_password_enc" text,
	"key_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_connect_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "mail_oauth_provider" NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"date_range_from" date,
	"date_range_to" date,
	"reconnect_source_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"folder_key" text NOT NULL,
	"initial_checkpoint" jsonb,
	"cursor" jsonb,
	"initial_complete" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailbox_credential" ADD CONSTRAINT "mailbox_credential_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connect_state" ADD CONSTRAINT "oauth_connect_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connect_state" ADD CONSTRAINT "oauth_connect_state_reconnect_source_id_connected_source_id_fk" FOREIGN KEY ("reconnect_source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursor" ADD CONSTRAINT "sync_cursor_source_id_connected_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."connected_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_connect_state_expires_at_idx" ON "oauth_connect_state" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursor_source_folder_uq" ON "sync_cursor" USING btree ("source_id","folder_key");
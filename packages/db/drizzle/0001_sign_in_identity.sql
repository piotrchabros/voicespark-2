CREATE TYPE "public"."identity_linked_via" AS ENUM('signup', 'confirmed_link', 'manual_link');--> statement-breakpoint
CREATE TABLE "sign_in_identity" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "sign_in_provider" NOT NULL,
	"provider_email" text,
	"email_verified" boolean NOT NULL,
	"is_relay_email" boolean NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_via" "identity_linked_via" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sign_in_identity" ADD CONSTRAINT "sign_in_identity_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_identity" ADD CONSTRAINT "sign_in_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_identity_user_id_idx" ON "sign_in_identity" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_identity_provider_account_uq" ON "sign_in_identity" USING btree ("provider","account_id");
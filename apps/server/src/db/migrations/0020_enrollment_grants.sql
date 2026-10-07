-- Phase 28. Access grants (ADR 0008), and who added each saved sense. Rows saved
-- before this phase were all saved by their list's owner, so the backfill is exact.
CREATE TABLE "enrollment_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"enrollment_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"grantee_user_id" text NOT NULL,
	"role" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_grants_enrollment_grantee_key" UNIQUE("enrollment_id","grantee_user_id"),
	CONSTRAINT "enrollment_grants_not_owner" CHECK ("enrollment_grants"."grantee_user_id" <> "enrollment_grants"."owner_user_id"),
	CONSTRAINT "enrollment_grants_role_known" CHECK ("enrollment_grants"."role" in ('tutor'))
);
--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD COLUMN "added_by_user_id" text;--> statement-breakpoint
UPDATE "vocabulary_entries" ve SET "added_by_user_id" = e."user_id" FROM "enrollments" e WHERE e."id" = ve."enrollment_id";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ALTER COLUMN "added_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollment_grants" ADD CONSTRAINT "enrollment_grants_enrollment_fk" FOREIGN KEY ("owner_user_id","enrollment_id") REFERENCES "public"."enrollments"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_grants" ADD CONSTRAINT "enrollment_grants_grantee_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollment_grants_grantee_idx" ON "enrollment_grants" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE INDEX "enrollment_grants_owner_idx" ON "enrollment_grants" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_added_by_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
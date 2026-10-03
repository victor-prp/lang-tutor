-- Phase 16. Learners hold enrollments; sessions and per-learner questions
-- belong to one. Deterministic, because users.target_language was never
-- editable (routes/users.ts is create + login only): every user becomes exactly
-- one enrollment carrying the pair they had, and every session joins it.
CREATE TABLE "enrollments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"source_language" varchar(10) NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_user_target_key" UNIQUE("user_id","target_language"),
	CONSTRAINT "enrollments_user_id_id_key" UNIQUE("user_id","id"),
	CONSTRAINT "enrollments_languages_differ" CHECK ("enrollments"."source_language" <> "enrollments"."target_language"),
	CONSTRAINT "enrollments_source_known" CHECK ("enrollments"."source_language" in ('he', 'en')),
	CONSTRAINT "enrollments_target_known" CHECK ("enrollments"."target_language" in ('he', 'en', 'ru'))
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "enrollments" ("user_id", "source_language", "target_language")
SELECT "id", "native_language", "target_language" FROM "users";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "enrollment_id" text;--> statement-breakpoint
UPDATE "sessions" SET "enrollment_id" = e."id"
  FROM "enrollments" e WHERE e."user_id" = "sessions"."user_id";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "enrollment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_enrollment_fk" FOREIGN KEY ("user_id","enrollment_id") REFERENCES "public"."enrollments"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "enrollment_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_enrollment_fk" FOREIGN KEY ("user_id","enrollment_id") REFERENCES "public"."enrollments"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_complete" CHECK (("questions"."user_id" is null) = ("questions"."enrollment_id" is null));--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_languages_differ";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "target_language";

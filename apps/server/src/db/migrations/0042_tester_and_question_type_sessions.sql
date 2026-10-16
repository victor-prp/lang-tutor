ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'practice' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "skipped_types" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tester" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_kind_known" CHECK ("sessions"."kind" in ('practice', 'question_types'));
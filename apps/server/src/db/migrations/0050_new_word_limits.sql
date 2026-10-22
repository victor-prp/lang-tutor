ALTER TABLE "sessions" ADD COLUMN "new_words_held" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "day_new_cap" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "day_new_cap" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "new_per_session" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_day_new_cap_range" CHECK ("users"."day_new_cap" between 1 and 100);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_new_per_session_known" CHECK ("users"."new_per_session" in (1, 2));
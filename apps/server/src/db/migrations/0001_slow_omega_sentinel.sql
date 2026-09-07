ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_format" CHECK ("users"."username" ~ '^[a-z0-9_]{3,30}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_display_name_length" CHECK (length("users"."display_name") between 1 and 60);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_age_range" CHECK ("users"."age" between 3 and 120);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_languages_differ" CHECK ("users"."native_language" <> "users"."target_language");
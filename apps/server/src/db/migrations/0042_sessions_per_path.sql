DROP INDEX "sessions_one_stock_per_enrollment";--> statement-breakpoint
DROP INDEX "sessions_one_started_per_enrollment";--> statement-breakpoint
ALTER TABLE "session_targets" ADD COLUMN "owed_gloss_ids" text[];--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_stock_per_path" ON "sessions" USING btree ("enrollment_id",coalesce("target_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "sessions"."status" in ('preparing', 'ready') and "sessions"."started_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_started_per_path" ON "sessions" USING btree ("enrollment_id",coalesce("target_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "sessions"."status" = 'ready' and "sessions"."started_at" is not null;
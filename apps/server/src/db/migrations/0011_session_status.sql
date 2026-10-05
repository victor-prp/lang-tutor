-- Phase 19. Sessions gain a status and a source. Finished sessions are
-- completed; unfinished ones become skipped, not ready: nothing ever resumed
-- them, and an open status would greet every existing learner with a stale
-- resume (and two of them would break the one-open index below). Every
-- existing session was drawn from the seed.
ALTER TABLE "sessions" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "source" text;--> statement-breakpoint
UPDATE "sessions"
   SET "status" = CASE WHEN "completed_at" IS NULL THEN 'skipped' ELSE 'completed' END,
       "source" = 'seed';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "source" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_open_per_enrollment" ON "sessions" USING btree ("enrollment_id") WHERE "sessions"."status" in ('preparing', 'ready');--> statement-breakpoint
CREATE INDEX "sessions_enrollment_created_idx" ON "sessions" USING btree ("enrollment_id","created_at");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_status_known" CHECK ("sessions"."status" in ('preparing', 'ready', 'completed', 'skipped', 'failed'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_source_known" CHECK ("sessions"."source" in ('seed', 'list'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_completed_consistent" CHECK (("sessions"."status" = 'completed') = ("sessions"."completed_at" is not null));
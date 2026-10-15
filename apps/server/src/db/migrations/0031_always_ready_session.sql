-- Phase 43 (spec D1). A session is started by its start call or its first
-- answer, and one started session may sit beside one in stock. Every session
-- with an answer was started at its first answer. What each existing session
-- was built for is unknown: false, so a stock that inherits it asks no
-- listening or speaking cards until the app's start call says the device can.
-- The default stays: the old container still inserts without either column
-- for the minute it serves after this runs (ADR 0010). At most one session per
-- enrollment was open before this, so both new indexes hold on the existing rows.
DROP INDEX "sessions_one_open_per_enrollment";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "listening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "speaking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "sessions" s
   SET "started_at" = first.answered_at
  FROM (SELECT "session_id", min("answered_at") AS answered_at FROM "answers" GROUP BY "session_id") first
 WHERE first.session_id = s.id;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_stock_per_enrollment" ON "sessions" USING btree ("enrollment_id") WHERE "sessions"."status" in ('preparing', 'ready') and "sessions"."started_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_started_per_enrollment" ON "sessions" USING btree ("enrollment_id") WHERE "sessions"."status" = 'ready' and "sessions"."started_at" is not null;

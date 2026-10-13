-- Phase 46 (spec D1, D3, D4). A skill counts once its stability has reached
-- KNOWN_STABILITY (7), and a gloss once known stays known, in a family or not.
-- A skill at 7 today has reached it, and last_day is the best date at hand; one
-- that reached it and has since slipped is found only by the recompute's replay,
-- which rebuilds reached_on exactly. Phase 39 stamped known_at on family members
-- only: it moves to the gloss. gloss_family_members.known_at stays, unread and
-- unwritten, because the old container still names it for the minute it serves
-- after this runs (ADR 0010); a later phase drops it.
ALTER TABLE "gloss_memory" ADD COLUMN "reached_on" date;--> statement-breakpoint
UPDATE "gloss_memory" SET "reached_on" = "last_day" WHERE "stability" >= 7;--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD COLUMN "known_at" timestamp with time zone;--> statement-breakpoint
UPDATE "vocabulary_entries" ve SET "known_at" = m."known_at"
FROM "gloss_family_members" m
WHERE m."enrollment_id" = ve."enrollment_id" AND m."gloss_id" = ve."gloss_id" AND m."known_at" IS NOT NULL;

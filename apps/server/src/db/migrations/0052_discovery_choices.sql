ALTER TABLE "discovery_cards" DROP CONSTRAINT "discovery_cards_answer_known";--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD COLUMN "choices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD COLUMN "right_choice" smallint;--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD COLUMN "picked" smallint;--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD COLUMN "suggested" text;--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD COLUMN "added" boolean;--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD COLUMN "saved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "started_by" text DEFAULT 'learner' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discover_count" smallint;--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD CONSTRAINT "discovery_cards_right_choice_range" CHECK ("discovery_cards"."right_choice" is null or "discovery_cards"."right_choice" between 0 and 3);--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD CONSTRAINT "discovery_cards_picked_range" CHECK ("discovery_cards"."picked" is null or "discovery_cards"."picked" between 0 and 3);--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD CONSTRAINT "discovery_cards_suggested_known" CHECK ("discovery_cards"."suggested" is null or "discovery_cards"."suggested" in ('add', 'skip'));--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD CONSTRAINT "discovery_cards_answer_known" CHECK ("discovery_cards"."answer" is null or "discovery_cards"."answer" in ('unknown', 'typed', 'choice'));--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_started_by_known" CHECK ("discovery_runs"."started_by" in ('learner', 'app'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_discover_count_range" CHECK ("users"."discover_count" between 1 and 30);--> statement-breakpoint
-- Phase 74 (spec D11). An open run's cards have no choices, and the app no longer draws a list: discarded.
UPDATE "discovery_runs" SET "status" = 'discarded', "ended_at" = now() WHERE "status" in ('asking', 'listing');

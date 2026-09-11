-- Phase 10 clears the seeded content and quiz tables so the new columns land on
-- empty tables: no backfills, no dropped defaults, and a migration that states
-- the target shape instead of negotiating with the old one.
--
-- CASCADE from vocab_terms reaches term_variants, vocab_term_senses,
-- term_sense_translations, questions, session_questions and answers. `sessions`
-- is named explicitly because nothing references it, so nothing would cascade
-- to it, and a session whose questions had vanished would be broken rather than
-- absent. `users` is untouched.
--
-- Without this, a developer's existing database keeps phase-4-shaped rows that
-- persistEntries refuses to overwrite — leaving that database permanently on
-- the old fixture while CI and every test template run on the new one.
--
-- The same statement is written again in src/db/reseed.ts rather than shared:
-- this file is frozen history, that command is live.
TRUNCATE vocab_terms, sessions CASCADE;
--> statement-breakpoint
ALTER TABLE "term_variants" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "vocab_term_senses" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "vocab_terms" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "term_sense_translations" ADD COLUMN "example_target" text;--> statement-breakpoint
ALTER TABLE "term_variants" ADD COLUMN "language_code" varchar(10) NOT NULL;--> statement-breakpoint
ALTER TABLE "term_variants" ADD COLUMN "entry_rank" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "vocab_term_senses" ADD COLUMN "part_of_speech" varchar(50);--> statement-breakpoint
ALTER TABLE "vocab_term_senses" ADD COLUMN "rank" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "vocab_term_senses" ADD COLUMN "example_source" text;--> statement-breakpoint
CREATE UNIQUE INDEX "term_variants_form_entry_rank_key" ON "term_variants" USING btree ("language_code",lower("form"),"entry_rank");--> statement-breakpoint
ALTER TABLE "vocab_terms" DROP COLUMN "part_of_speech";--> statement-breakpoint
ALTER TABLE "vocab_term_senses" ADD CONSTRAINT "vocab_term_senses_term_rank_key" UNIQUE("term_id","rank");--> statement-breakpoint
ALTER TABLE "term_variants" ADD CONSTRAINT "term_variants_entry_rank_nonneg" CHECK ("term_variants"."entry_rank" >= 0);--> statement-breakpoint
ALTER TABLE "vocab_term_senses" ADD CONSTRAINT "vocab_term_senses_rank_nonneg" CHECK ("vocab_term_senses"."rank" >= 0);
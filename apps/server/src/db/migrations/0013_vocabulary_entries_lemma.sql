-- Phase 21. The saved list groups by lemma, so each entry carries its lexeme's
-- lemma. Added nullable, backfilled from dict_lexemes, then made NOT NULL, so
-- existing entries survive. The composite foreign key keeps the copy equal to
-- the lexeme's lemma, and cascades a rewrite of it; nothing rewrites one today.
-- The lexeme index is replaced by a lemma index: its two readers now read by
-- lemma. Both indexes are built inside the migration transaction.
ALTER TABLE "vocabulary_entries" DROP CONSTRAINT "vocabulary_entries_lexeme_fk";--> statement-breakpoint
DROP INDEX "vocabulary_entries_enrollment_lexeme_idx";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD COLUMN "lemma" text;--> statement-breakpoint
UPDATE "vocabulary_entries" ve SET "lemma" = l."lemma" FROM "dict_lexemes" l WHERE l."id" = ve."lexeme_id";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ALTER COLUMN "lemma" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dict_lexemes" ADD CONSTRAINT "dict_lexemes_id_lemma_key" UNIQUE("id","lemma");--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_lexeme_lemma_fk" FOREIGN KEY ("lexeme_id","lemma") REFERENCES "public"."dict_lexemes"("id","lemma") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "vocabulary_entries_enrollment_lemma_idx" ON "vocabulary_entries" USING btree ("enrollment_id","lemma","created_at");

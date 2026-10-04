-- Phase 18. A learner's word list, keyed (enrollment, sense), and the index that
-- lets "which renderings does this sense have" avoid scanning
-- dict_var_translations. Nothing is backfilled: no saved-word data exists.
-- The index is built inside the migration transaction (no CONCURRENTLY); check
-- dict_var_translations' production row count before merging (spec §2).
CREATE TABLE "vocabulary_entries" (
	"enrollment_id" text NOT NULL,
	"sense_id" text NOT NULL,
	"lexeme_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vocabulary_entries_pkey" PRIMARY KEY("enrollment_id","sense_id")
);
--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_sense_fk" FOREIGN KEY ("sense_id") REFERENCES "public"."dict_senses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_lexeme_fk" FOREIGN KEY ("lexeme_id") REFERENCES "public"."dict_lexemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_variant_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."dict_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vocabulary_entries_enrollment_lexeme_idx" ON "vocabulary_entries" USING btree ("enrollment_id","lexeme_id","created_at");--> statement-breakpoint
CREATE INDEX "dict_var_translations_sense_language_idx" ON "dict_var_translations" USING btree ("sense_id","user_language_code");
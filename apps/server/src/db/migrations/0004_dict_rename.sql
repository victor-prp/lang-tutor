-- Phase 12, part one: names only. A term is about to become a lexeme, so the
-- rename lands on its own, ahead of any change to what a row means. Every
-- statement here is a RENAME: no row moves, no column changes type, and the
-- data this runs against is the data it leaves behind.
--
-- Hand-written rather than generated. drizzle-kit cannot infer a rename without
-- an interactive prompt, and the alternative it emits unprompted is DROP and
-- CREATE — which for these four tables means deleting the dictionary to rename
-- it. The snapshot beside this file describes the same target shape, and
-- `npm run db:check` is what holds the two together.
ALTER TABLE vocab_terms             RENAME TO dict_lexemes;--> statement-breakpoint
ALTER TABLE term_variants           RENAME TO dict_variants;--> statement-breakpoint
ALTER TABLE vocab_term_senses       RENAME TO dict_senses;--> statement-breakpoint
ALTER TABLE term_sense_translations RENAME TO dict_var_translations;--> statement-breakpoint

ALTER TABLE dict_variants RENAME COLUMN term_id TO lexeme_id;--> statement-breakpoint
ALTER TABLE dict_senses   RENAME COLUMN term_id TO lexeme_id;--> statement-breakpoint

-- Renaming a unique CONSTRAINT renames its backing index with it; only
-- dict_variants_form_entry_rank_key is a bare index, so only it needs ALTER
-- INDEX at the bottom.
ALTER TABLE dict_lexemes  RENAME CONSTRAINT vocab_terms_pkey                  TO dict_lexemes_pkey;--> statement-breakpoint
ALTER TABLE dict_lexemes  RENAME CONSTRAINT vocab_terms_language_lemma_key    TO dict_lexemes_language_lemma_key;--> statement-breakpoint
ALTER TABLE dict_variants RENAME CONSTRAINT term_variants_pkey                TO dict_variants_pkey;--> statement-breakpoint
ALTER TABLE dict_variants RENAME CONSTRAINT term_variants_term_form_key       TO dict_variants_lexeme_form_key;--> statement-breakpoint
ALTER TABLE dict_variants RENAME CONSTRAINT term_variants_entry_rank_nonneg   TO dict_variants_entry_rank_nonneg;--> statement-breakpoint
ALTER TABLE dict_senses   RENAME CONSTRAINT vocab_term_senses_pkey            TO dict_senses_pkey;--> statement-breakpoint
ALTER TABLE dict_senses   RENAME CONSTRAINT vocab_term_senses_term_rank_key   TO dict_senses_lexeme_rank_key;--> statement-breakpoint
ALTER TABLE dict_senses   RENAME CONSTRAINT vocab_term_senses_rank_nonneg     TO dict_senses_rank_nonneg;--> statement-breakpoint

-- The drizzle-generated foreign keys carry the old table and column names in
-- their own names, so the new snapshot expects all five to have moved too.
ALTER TABLE dict_variants RENAME CONSTRAINT term_variants_term_id_vocab_terms_id_fk
  TO dict_variants_lexeme_id_dict_lexemes_id_fk;--> statement-breakpoint
ALTER TABLE dict_senses   RENAME CONSTRAINT vocab_term_senses_term_id_vocab_terms_id_fk
  TO dict_senses_lexeme_id_dict_lexemes_id_fk;--> statement-breakpoint
ALTER TABLE dict_var_translations RENAME CONSTRAINT term_sense_translations_sense_id_user_language_code_pk
  TO dict_var_translations_sense_id_user_language_code_pk;--> statement-breakpoint
ALTER TABLE dict_var_translations RENAME CONSTRAINT term_sense_translations_sense_id_vocab_term_senses_id_fk
  TO dict_var_translations_sense_id_dict_senses_id_fk;--> statement-breakpoint
ALTER TABLE questions RENAME CONSTRAINT questions_sense_id_vocab_term_senses_id_fk
  TO questions_sense_id_dict_senses_id_fk;--> statement-breakpoint
ALTER TABLE questions RENAME CONSTRAINT questions_prompt_variant_id_term_variants_id_fk
  TO questions_prompt_variant_id_dict_variants_id_fk;--> statement-breakpoint

ALTER INDEX term_variants_form_entry_rank_key RENAME TO dict_variants_form_entry_rank_key;

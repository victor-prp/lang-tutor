-- Phase 34 (spec §2, Data). Every column and check the phase needs, in one
-- migration: a rendering's accepted answers (D1, D2), a question's context
-- sentence, marked words and answer form (D6, D8, D2), and a second try on an
-- answer (D9). Every existing row satisfies the new checks unchanged: the new
-- columns are null ('{}' for the list) on all of them, and the alternatives cap
-- only rises, from five to ten.
ALTER TABLE "questions" DROP CONSTRAINT "questions_shape_valid";--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "retry_state" text;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "retry_text" text;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "retry_verdict" text;--> statement-breakpoint
ALTER TABLE "dict_var_translations" ADD COLUMN "accepted_answers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "dict_var_translations" ADD COLUMN "answer_form" text;--> statement-breakpoint
ALTER TABLE "dict_var_translations" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "context_translation" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "context_mark_start" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "context_mark_end" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "sentence_mark_start" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "sentence_mark_end" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "answer_form" text;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_retry_state_known" CHECK ("answers"."retry_state" in ('pending', 'resolved'));--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_retry_only_on_alternative" CHECK ("answers"."retry_state" is null or ("answers"."verdict" = 'alternative') is true);--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_retry_resolved_complete" CHECK (("answers"."retry_state" is not distinct from 'resolved') = ("answers"."retry_text" is not null)
        and ("answers"."retry_state" is not distinct from 'resolved') = ("answers"."retry_verdict" is not null));--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_retry_verdict_known" CHECK ("answers"."retry_verdict" in ('exact', 'near_miss', 'alternative', 'wrong', 'understood', 'gave_up', 'skipped'));--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_retry_text_length" CHECK (length("answers"."retry_text") <= 300);--> statement-breakpoint
ALTER TABLE "dict_var_translations" ADD CONSTRAINT "dict_var_translations_accepted_answers_cap" CHECK (cardinality("dict_var_translations"."accepted_answers") <= 10);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_marks_valid" CHECK (("questions"."context_mark_start" is null) = ("questions"."context_mark_end" is null)
        and ("questions"."sentence_mark_start" is null) = ("questions"."sentence_mark_end" is null)
        and ("questions"."context_translation" is null or "questions"."context" is not null)
        and ("questions"."context_mark_start" is null or ("questions"."context" is not null and "questions"."context_mark_start" >= 0
          and "questions"."context_mark_start" < "questions"."context_mark_end" and "questions"."context_mark_end" <= length("questions"."context")))
        and ("questions"."sentence_mark_start" is null or ("questions"."sentence_translation" is not null and "questions"."sentence_mark_start" >= 0
          and "questions"."sentence_mark_start" < "questions"."sentence_mark_end" and "questions"."sentence_mark_end" <= length("questions"."sentence_translation"))));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_shape_valid" CHECK (case "questions"."type"
        when 'multiple_choice' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'listen_choice' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'matching' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'reverse_choice' then "questions"."options" is not null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'typed_translation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."tiles" is null
          and "questions"."alternatives" is not null and coalesce(array_length("questions"."alternatives", 1), 0) <= 10
        when 'dictation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'letter_tiles' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null
          and coalesce(array_length("questions"."tiles", 1), 0) between 5 and 12
        when 'read_aloud' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'say_translation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."tiles" is null
          and "questions"."alternatives" is not null and coalesce(array_length("questions"."alternatives", 1), 0) <= 10
        when 'typed_meaning' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'cloze_choice' then "questions"."options" is not null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'cloze_typed' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."tiles" is null
          and "questions"."alternatives" is not null and coalesce(array_length("questions"."alternatives", 1), 0) <= 10
        when 'sentence_translation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        else false end
        and ("questions"."type" in ('typed_translation', 'say_translation', 'reverse_choice', 'typed_meaning', 'multiple_choice')
          or ("questions"."context" is null and "questions"."context_translation" is null
            and "questions"."context_mark_start" is null and "questions"."context_mark_end" is null))
        and ("questions"."type" in ('cloze_typed', 'sentence_translation')
          or ("questions"."sentence_mark_start" is null and "questions"."sentence_mark_end" is null)));
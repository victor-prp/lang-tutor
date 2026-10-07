-- Phase 27 Part B. The three sentence cards (spec D11): their sentence, its
-- Hebrew and the gap offsets live on the question row. Every existing row
-- satisfies the new checks unchanged: no question is of a new type, and the
-- four new columns are null on all of them.
ALTER TABLE "questions" DROP CONSTRAINT "questions_type_known";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_shape_valid";--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "sentence" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "sentence_translation" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "gap_start" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "gap_end" integer;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_sentence_valid" CHECK (("questions"."type" in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = ("questions"."sentence" is not null)
        and ("questions"."type" in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = ("questions"."sentence_translation" is not null)
        and ("questions"."type" in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = ("questions"."gap_start" is not null)
        and ("questions"."type" in ('cloze_choice', 'cloze_typed', 'sentence_translation')) = ("questions"."gap_end" is not null)
        and ("questions"."gap_start" is null or ("questions"."gap_start" >= 0 and "questions"."gap_start" < "questions"."gap_end" and "questions"."gap_end" <= length("questions"."sentence"))));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_type_known" CHECK ("questions"."type" in ('multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles', 'read_aloud', 'say_translation', 'typed_meaning', 'cloze_choice', 'cloze_typed', 'sentence_translation'));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_shape_valid" CHECK (case "questions"."type"
        when 'multiple_choice' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'listen_choice' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'matching' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'reverse_choice' then "questions"."options" is not null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'typed_translation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."tiles" is null
          and "questions"."alternatives" is not null and coalesce(array_length("questions"."alternatives", 1), 0) <= 5
        when 'dictation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'letter_tiles' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null
          and coalesce(array_length("questions"."tiles", 1), 0) between 5 and 12
        when 'read_aloud' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'say_translation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."tiles" is null
          and "questions"."alternatives" is not null and coalesce(array_length("questions"."alternatives", 1), 0) <= 5
        when 'typed_meaning' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'cloze_choice' then "questions"."options" is not null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'cloze_typed' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."tiles" is null
          and "questions"."alternatives" is not null and coalesce(array_length("questions"."alternatives", 1), 0) <= 5
        when 'sentence_translation' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        else false end);
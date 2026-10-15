ALTER TABLE "answers" DROP CONSTRAINT "answers_verdict_known";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_type_known";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_shape_valid";--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_verdict_known" CHECK ("answers"."verdict" in ('exact', 'near_miss', 'alternative', 'wrong', 'understood', 'gave_up', 'skipped', 'seen'));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_type_known" CHECK ("questions"."type" in ('multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles', 'read_aloud', 'say_translation', 'typed_meaning', 'cloze_choice', 'cloze_typed', 'sentence_translation', 'new_meaning', 'meet'));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_shape_valid" CHECK (case "questions"."type"
        when 'multiple_choice' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
        when 'new_meaning' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null and "questions"."tiles" is null
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
        when 'meet' then "questions"."options" is null and "questions"."prompt" is not null and "questions"."alternatives" is null and "questions"."tiles" is null
        else false end
        and ("questions"."type" in ('typed_translation', 'say_translation', 'reverse_choice', 'typed_meaning', 'multiple_choice', 'new_meaning')
          or ("questions"."context" is null and "questions"."context_translation" is null
            and "questions"."context_mark_start" is null and "questions"."context_mark_end" is null))
        and ("questions"."type" in ('cloze_typed', 'sentence_translation')
          or ("questions"."sentence_mark_start" is null and "questions"."sentence_mark_end" is null)));
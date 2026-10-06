-- Phase 23. Reversed and typed questions, and typed answers (spec D12, D13).
-- Every existing row satisfies the new checks unchanged: every question is a
-- multiple_choice with options and no prompt or alternatives, and every answer
-- has an option and no text.
ALTER TABLE "questions" DROP CONSTRAINT "questions_options_valid";--> statement-breakpoint
ALTER TABLE "answers" ALTER COLUMN "selected_option_position" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "options" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "typed_text" text;--> statement-breakpoint
ALTER TABLE "answers" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "alternatives" text[];--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_kind_valid" CHECK (("answers"."selected_option_position" is null) = ("answers"."typed_text" is not null) and ("answers"."typed_text" is null) = ("answers"."verdict" is null));--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_verdict_known" CHECK ("answers"."verdict" in ('exact', 'near_miss', 'alternative', 'wrong'));--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_typed_text_length" CHECK (length("answers"."typed_text") <= 100);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_type_known" CHECK ("questions"."type" in ('multiple_choice', 'reverse_choice', 'typed_translation'));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_shape_valid" CHECK (case "questions"."type"
        when 'multiple_choice' then "questions"."options" is not null and "questions"."prompt" is null and "questions"."alternatives" is null
        when 'reverse_choice' then "questions"."options" is not null and "questions"."prompt" is not null and "questions"."alternatives" is null
        when 'typed_translation' then "questions"."options" is null and "questions"."prompt" is not null
          and "questions"."alternatives" is not null and coalesce(array_length("questions"."alternatives", 1), 0) <= 5
        else false end);--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_options_valid" CHECK ("questions"."options" is null or question_options_valid("questions"."options"));
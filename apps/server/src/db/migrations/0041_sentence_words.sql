CREATE TABLE "answer_taps" (
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"word_index" integer NOT NULL,
	"kind" text NOT NULL,
	"gloss_id" text,
	"tapped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_taps_session_id_position_word_index_pk" PRIMARY KEY("session_id","position","word_index"),
	CONSTRAINT "answer_taps_kind_known" CHECK ("answer_taps"."kind" in ('target', 'list', 'free')),
	CONSTRAINT "answer_taps_gloss_on_list" CHECK (("answer_taps"."kind" = 'list') = ("answer_taps"."gloss_id" is not null)),
	CONSTRAINT "answer_taps_word_index_nonneg" CHECK ("answer_taps"."word_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "words" jsonb;--> statement-breakpoint
ALTER TABLE "answer_taps" ADD CONSTRAINT "answer_taps_session_id_position_answers_session_id_position_fk" FOREIGN KEY ("session_id","position") REFERENCES "public"."answers"("session_id","position") ON DELETE cascade ON UPDATE no action;
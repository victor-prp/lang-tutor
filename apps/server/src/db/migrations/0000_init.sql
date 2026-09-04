CREATE TABLE "answers" (
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question_id" text NOT NULL,
	"selected_option_position" integer NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_session_id_position_pk" PRIMARY KEY("session_id","position"),
	CONSTRAINT "answers_selected_option_position_nonneg" CHECK ("answers"."selected_option_position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"sense_id" text NOT NULL,
	"prompt_variant_id" text NOT NULL,
	"target_language" varchar(10) NOT NULL,
	"user_language_code" varchar(10) NOT NULL,
	"type" varchar(50) NOT NULL,
	"options" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_options_valid" CHECK (question_options_valid("questions"."options"))
);
--> statement-breakpoint
CREATE TABLE "session_questions" (
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question_id" text NOT NULL,
	"option_order" integer[] NOT NULL,
	CONSTRAINT "session_questions_session_id_position_pk" PRIMARY KEY("session_id","position"),
	CONSTRAINT "session_questions_position_question_key" UNIQUE("session_id","position","question_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "term_sense_translations" (
	"sense_id" text NOT NULL,
	"user_language_code" varchar(10) NOT NULL,
	"translation" text NOT NULL,
	"definition_notes" text,
	CONSTRAINT "term_sense_translations_sense_id_user_language_code_pk" PRIMARY KEY("sense_id","user_language_code")
);
--> statement-breakpoint
CREATE TABLE "term_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"term_id" text NOT NULL,
	"form" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "term_variants_term_form_key" UNIQUE("term_id","form")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"native_language" varchar(10) DEFAULT 'he' NOT NULL,
	"target_language" varchar(10) DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocab_term_senses" (
	"id" text PRIMARY KEY NOT NULL,
	"term_id" text NOT NULL,
	"sense_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocab_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"language_code" varchar(10) NOT NULL,
	"lemma" text NOT NULL,
	"part_of_speech" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vocab_terms_language_lemma_key" UNIQUE("language_code","lemma")
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_id_position_question_id_session_questions_session_id_position_question_id_fk" FOREIGN KEY ("session_id","position","question_id") REFERENCES "public"."session_questions"("session_id","position","question_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_sense_id_vocab_term_senses_id_fk" FOREIGN KEY ("sense_id") REFERENCES "public"."vocab_term_senses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_prompt_variant_id_term_variants_id_fk" FOREIGN KEY ("prompt_variant_id") REFERENCES "public"."term_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_questions" ADD CONSTRAINT "session_questions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_questions" ADD CONSTRAINT "session_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_sense_translations" ADD CONSTRAINT "term_sense_translations_sense_id_vocab_term_senses_id_fk" FOREIGN KEY ("sense_id") REFERENCES "public"."vocab_term_senses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_variants" ADD CONSTRAINT "term_variants_term_id_vocab_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."vocab_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocab_term_senses" ADD CONSTRAINT "vocab_term_senses_term_id_vocab_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."vocab_terms"("id") ON DELETE cascade ON UPDATE no action;
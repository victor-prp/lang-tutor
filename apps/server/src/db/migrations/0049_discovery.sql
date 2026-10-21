CREATE TABLE "discovery_cards" (
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"round" smallint NOT NULL,
	"level" smallint NOT NULL,
	"word" text NOT NULL,
	"part_of_speech" text NOT NULL,
	"hebrew" text NOT NULL,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" text,
	"typed_text" text,
	"verdict" text,
	"known" boolean,
	"judged_by" text,
	"answered_at" timestamp with time zone,
	"lookup_status" text,
	"corrected_form" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_gloss_id" text,
	"chosen_gloss_id" text,
	"ticked" boolean DEFAULT false NOT NULL,
	"hebrew_mismatch" boolean DEFAULT false NOT NULL,
	"reason" text,
	CONSTRAINT "discovery_cards_pkey" PRIMARY KEY("run_id","position"),
	CONSTRAINT "discovery_cards_answer_known" CHECK ("discovery_cards"."answer" is null or "discovery_cards"."answer" in ('unknown', 'typed')),
	CONSTRAINT "discovery_cards_verdict_known" CHECK ("discovery_cards"."verdict" is null or "discovery_cards"."verdict" in ('exact', 'alternative', 'wrong')),
	CONSTRAINT "discovery_cards_judged_by_known" CHECK ("discovery_cards"."judged_by" is null or "discovery_cards"."judged_by" in ('rule', 'model', 'unavailable')),
	CONSTRAINT "discovery_cards_lookup_status_known" CHECK ("discovery_cards"."lookup_status" is null or "discovery_cards"."lookup_status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "discovery_cards_reason_known" CHECK ("discovery_cards"."reason" is null or "discovery_cards"."reason" in ('sentence', 'no_meaning', 'not_in_language')),
	CONSTRAINT "discovery_cards_tick_needs_gloss" CHECK (not "discovery_cards"."ticked" or "discovery_cards"."chosen_gloss_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "discovery_profiles" (
	"enrollment_id" text PRIMARY KEY NOT NULL,
	"self_level" text NOT NULL,
	"learning_context" text NOT NULL,
	"level" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_profiles_self_level_known" CHECK ("discovery_profiles"."self_level" in ('none', 'basic', 'simple', 'everyday', 'fluent')),
	CONSTRAINT "discovery_profiles_learning_context_known" CHECK ("discovery_profiles"."learning_context" in ('school', 'course', 'self', 'family')),
	CONSTRAINT "discovery_profiles_level_known" CHECK ("discovery_profiles"."level" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" text NOT NULL,
	"goal" smallint NOT NULL,
	"status" text NOT NULL,
	"settled_round" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "discovery_runs_status_known" CHECK ("discovery_runs"."status" in ('asking', 'listing', 'saved', 'discarded')),
	CONSTRAINT "discovery_runs_goal_known" CHECK ("discovery_runs"."goal" between 1 and 30)
);
--> statement-breakpoint
ALTER TABLE "discovery_cards" ADD CONSTRAINT "discovery_cards_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_profiles" ADD CONSTRAINT "discovery_profiles_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_runs_one_open_per_enrollment" ON "discovery_runs" USING btree ("enrollment_id") WHERE "discovery_runs"."status" in ('asking', 'listing');--> statement-breakpoint
CREATE INDEX "discovery_runs_enrollment_created_idx" ON "discovery_runs" USING btree ("enrollment_id","created_at");
-- Phase 39 (spec D4, D6). The three gloss-family tables, and the new_meaning card:
-- a question's known_meanings and the type in the two checks that list the types.
-- Every existing row satisfies the new checks unchanged: known_meanings is null on all of them.
CREATE TABLE "gloss_families" (
	"id" text PRIMARY KEY NOT NULL,
	"enrollment_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gloss_family_events" (
	"id" text PRIMARY KEY NOT NULL,
	"enrollment_id" text NOT NULL,
	"family_id" text NOT NULL,
	"gloss_id" text NOT NULL,
	"session_id" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"evidence" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gloss_family_members" (
	"enrollment_id" text NOT NULL,
	"gloss_id" text NOT NULL,
	"family_id" text NOT NULL,
	"state" text NOT NULL,
	"position" integer NOT NULL,
	"known_at" timestamp with time zone,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gloss_family_members_pkey" PRIMARY KEY("enrollment_id","gloss_id"),
	CONSTRAINT "gloss_family_members_state_known" CHECK ("gloss_family_members"."state" in ('known', 'current', 'waiting'))
);
--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_type_known";--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_shape_valid";--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "known_meanings" text[];--> statement-breakpoint
ALTER TABLE "gloss_families" ADD CONSTRAINT "gloss_families_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gloss_family_events" ADD CONSTRAINT "gloss_family_events_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gloss_family_members" ADD CONSTRAINT "gloss_family_members_family_id_gloss_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."gloss_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gloss_family_members" ADD CONSTRAINT "gloss_family_members_entry_fk" FOREIGN KEY ("enrollment_id","gloss_id") REFERENCES "public"."vocabulary_entries"("enrollment_id","gloss_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "gloss_families_enrollment_idx" ON "gloss_families" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "gloss_family_events_enrollment_at_idx" ON "gloss_family_events" USING btree ("enrollment_id","at");--> statement-breakpoint
CREATE INDEX "gloss_family_members_family_idx" ON "gloss_family_members" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_known_meanings_valid" CHECK (("questions"."type" = 'new_meaning') = ("questions"."known_meanings" is not null and cardinality("questions"."known_meanings") > 0));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_type_known" CHECK ("questions"."type" in ('multiple_choice', 'reverse_choice', 'typed_translation', 'listen_choice', 'dictation', 'matching', 'letter_tiles', 'read_aloud', 'say_translation', 'typed_meaning', 'cloze_choice', 'cloze_typed', 'sentence_translation', 'new_meaning'));--> statement-breakpoint
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
        else false end
        and ("questions"."type" in ('typed_translation', 'say_translation', 'reverse_choice', 'typed_meaning', 'multiple_choice', 'new_meaning')
          or ("questions"."context" is null and "questions"."context_translation" is null
            and "questions"."context_mark_start" is null and "questions"."context_mark_end" is null))
        and ("questions"."type" in ('cloze_typed', 'sentence_translation')
          or ("questions"."sentence_mark_start" is null and "questions"."sentence_mark_end" is null)));
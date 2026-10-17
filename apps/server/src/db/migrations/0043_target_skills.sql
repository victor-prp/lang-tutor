CREATE TABLE "target_skill_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"gloss_id" text NOT NULL,
	"dimension" text NOT NULL,
	"session_id" uuid NOT NULL,
	"before" smallint NOT NULL,
	"after" smallint NOT NULL,
	"why" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_skill_events_dimension_known" CHECK ("target_skill_events"."dimension" in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')),
	CONSTRAINT "target_skill_events_why_known" CHECK ("target_skill_events"."why" in ('miss', 'recall', 'recognition')),
	CONSTRAINT "target_skill_events_values_range" CHECK ("target_skill_events"."before" between 0 and 20 and "target_skill_events"."after" between 0 and 20)
);
--> statement-breakpoint
CREATE TABLE "target_skills" (
	"target_id" uuid NOT NULL,
	"gloss_id" text NOT NULL,
	"dimension" text NOT NULL,
	"halves" smallint NOT NULL,
	"session_id" uuid,
	"day" date,
	CONSTRAINT "target_skills_pkey" PRIMARY KEY("target_id","gloss_id","dimension"),
	CONSTRAINT "target_skills_dimension_known" CHECK ("target_skills"."dimension" in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')),
	CONSTRAINT "target_skills_halves_range" CHECK ("target_skills"."halves" between 0 and 20)
);
--> statement-breakpoint
DROP INDEX "sessions_one_stock_per_enrollment";--> statement-breakpoint
DROP INDEX "sessions_one_started_per_enrollment";--> statement-breakpoint
ALTER TABLE "session_targets" ALTER COLUMN "wish" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_targets" ALTER COLUMN "slots" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_targets" ALTER COLUMN "picked" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_targets" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_targets" ADD COLUMN "cap_halves" integer;--> statement-breakpoint
ALTER TABLE "session_targets" ADD COLUMN "readiness_pct" integer;--> statement-breakpoint
ALTER TABLE "session_targets" ADD COLUMN "fsrs_ready_count" integer;--> statement-breakpoint
ALTER TABLE "session_targets" ADD COLUMN "owed_gloss_ids" text[];--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "target_id" uuid;--> statement-breakpoint
ALTER TABLE "target_words" ADD COLUMN "started_on" date;--> statement-breakpoint
ALTER TABLE "target_skill_events" ADD CONSTRAINT "target_skill_events_target_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_skills" ADD CONSTRAINT "target_skills_word_fk" FOREIGN KEY ("target_id","gloss_id") REFERENCES "public"."target_words"("target_id","gloss_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "target_skill_events_target_created_idx" ON "target_skill_events" USING btree ("target_id","created_at");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_target_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_stock_per_path" ON "sessions" USING btree ("enrollment_id",coalesce("target_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "sessions"."status" in ('preparing', 'ready') and "sessions"."started_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_started_per_path" ON "sessions" USING btree ("enrollment_id",coalesce("target_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "sessions"."status" = 'ready' and "sessions"."started_at" is not null;
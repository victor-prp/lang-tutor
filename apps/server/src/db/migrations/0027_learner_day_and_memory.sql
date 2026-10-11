CREATE TABLE "gloss_memory" (
	"enrollment_id" text NOT NULL,
	"gloss_id" text NOT NULL,
	"dimension" text NOT NULL,
	"stability" real NOT NULL,
	"difficulty" real NOT NULL,
	"last_day" date NOT NULL,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"params" text NOT NULL,
	CONSTRAINT "gloss_memory_pkey" PRIMARY KEY("enrollment_id","gloss_id","dimension"),
	CONSTRAINT "gloss_memory_dimension_known" CHECK ("gloss_memory"."dimension" in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')),
	CONSTRAINT "gloss_memory_stability_positive" CHECK ("gloss_memory"."stability" > 0),
	CONSTRAINT "gloss_memory_difficulty_range" CHECK ("gloss_memory"."difficulty" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "practice_day" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'learner' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_day" date;--> statement-breakpoint
ALTER TABLE "gloss_memory" ADD CONSTRAINT "gloss_memory_entry_fk" FOREIGN KEY ("enrollment_id","gloss_id") REFERENCES "public"."vocabulary_entries"("enrollment_id","gloss_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kind_known" CHECK ("users"."kind" in ('learner', 'bot'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bot_day_iff_bot" CHECK (("users"."kind" = 'bot') = ("users"."bot_day" is not null));--> statement-breakpoint
UPDATE sessions s SET practice_day = (SELECT ((max(a.answered_at)) AT TIME ZONE 'UTC')::date FROM answers a WHERE a.session_id = s.id) WHERE s.status IN ('completed','skipped');

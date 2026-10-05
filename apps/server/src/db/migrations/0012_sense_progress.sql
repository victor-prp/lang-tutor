-- Phase 20. Progress per saved sense, and what each ended session did to it.
-- Every entry saved before this phase gets its five rows at level 1: nothing
-- was practised from a saved list before phase 19, and only answers given
-- while a sense is saved count, so no session is re-evaluated.
CREATE TABLE "sense_progress" (
	"enrollment_id" text NOT NULL,
	"sense_id" text NOT NULL,
	"dimension" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"last_step_on" date,
	"last_wrong_on" date,
	CONSTRAINT "sense_progress_pkey" PRIMARY KEY("enrollment_id","sense_id","dimension"),
	CONSTRAINT "sense_progress_dimension_known" CHECK ("sense_progress"."dimension" in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')),
	CONSTRAINT "sense_progress_level_range" CHECK ("sense_progress"."level" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "session_progress" (
	"session_id" uuid NOT NULL,
	"sense_id" text NOT NULL,
	"dimension" text NOT NULL,
	"level_before" integer NOT NULL,
	"level_after" integer NOT NULL,
	CONSTRAINT "session_progress_pkey" PRIMARY KEY("session_id","sense_id","dimension"),
	CONSTRAINT "session_progress_dimension_known" CHECK ("session_progress"."dimension" in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')),
	CONSTRAINT "session_progress_levels_valid" CHECK ("session_progress"."level_before" between 1 and 5 and "session_progress"."level_after" between "session_progress"."level_before" and 5)
);
--> statement-breakpoint
ALTER TABLE "sense_progress" ADD CONSTRAINT "sense_progress_entry_fk" FOREIGN KEY ("enrollment_id","sense_id") REFERENCES "public"."vocabulary_entries"("enrollment_id","sense_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_progress" ADD CONSTRAINT "session_progress_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sense_progress_enrollment_dimension_idx" ON "sense_progress" USING btree ("enrollment_id","dimension","sense_id","level");--> statement-breakpoint
INSERT INTO "sense_progress" ("enrollment_id", "sense_id", "dimension")
SELECT ve."enrollment_id", ve."sense_id", d."dimension"
FROM "vocabulary_entries" ve
CROSS JOIN (VALUES ('written_receptive'), ('written_productive'), ('spoken_receptive'),
                   ('spoken_productive'), ('spelling')) AS d("dimension");
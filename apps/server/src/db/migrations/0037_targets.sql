CREATE TABLE "session_targets" (
	"session_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"wish" integer NOT NULL,
	"slots" integer NOT NULL,
	"picked" integer NOT NULL,
	"reason" text NOT NULL,
	"days_left" integer NOT NULL,
	"ready_count" integer NOT NULL,
	"word_count" integer NOT NULL,
	CONSTRAINT "session_targets_pkey" PRIMARY KEY("session_id","target_id"),
	CONSTRAINT "session_targets_reason_known" CHECK ("session_targets"."reason" in ('exclusive', 'run_up', 'not_ready', 'steady'))
);
--> statement-breakpoint
CREATE TABLE "target_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"actor_user_id" text,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_events_kind_known" CHECK ("target_events"."kind" in ('created', 'words_added', 'words_removed', 'date_changed', 'ended_early', 'ended_on_date'))
);
--> statement-breakpoint
CREATE TABLE "target_words" (
	"target_id" uuid NOT NULL,
	"gloss_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_words_pkey" PRIMARY KEY("target_id","gloss_id")
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" text NOT NULL,
	"kind" text NOT NULL,
	"due_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "targets_kind_known" CHECK ("targets"."kind" in ('homework', 'exam'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "chosen_on" date;--> statement-breakpoint
ALTER TABLE "session_targets" ADD CONSTRAINT "session_targets_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_targets" ADD CONSTRAINT "session_targets_target_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_events" ADD CONSTRAINT "target_events_target_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_words" ADD CONSTRAINT "target_words_target_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_words" ADD CONSTRAINT "target_words_gloss_fk" FOREIGN KEY ("gloss_id") REFERENCES "public"."dict_glosses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "target_events_target_created_idx" ON "target_events" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE INDEX "target_words_gloss_idx" ON "target_words" USING btree ("gloss_id");--> statement-breakpoint
CREATE INDEX "targets_enrollment_due_idx" ON "targets" USING btree ("enrollment_id","due_on");
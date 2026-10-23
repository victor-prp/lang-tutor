CREATE TABLE "my_words_days" (
	"enrollment_id" text NOT NULL,
	"day" date NOT NULL,
	"goal" smallint,
	"sessions_done" smallint NOT NULL,
	"new_words" smallint NOT NULL,
	"moved_up" smallint NOT NULL,
	"last_session_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "my_words_days_pk" PRIMARY KEY("enrollment_id","day"),
	CONSTRAINT "my_words_days_goal_range" CHECK ("my_words_days"."goal" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "my_words_goal" smallint;--> statement-breakpoint
ALTER TABLE "my_words_days" ADD CONSTRAINT "my_words_days_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_my_words_goal_range" CHECK ("enrollments"."my_words_goal" between 0 and 20);
CREATE TABLE "answer_explanations" (
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"corrected" text NOT NULL,
	"mistakes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_explanations_session_id_position_pk" PRIMARY KEY("session_id","position")
);
--> statement-breakpoint
ALTER TABLE "answer_explanations" ADD CONSTRAINT "answer_explanations_session_id_position_answers_session_id_position_fk" FOREIGN KEY ("session_id","position") REFERENCES "public"."answers"("session_id","position") ON DELETE cascade ON UPDATE no action;
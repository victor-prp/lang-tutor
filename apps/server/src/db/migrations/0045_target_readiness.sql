CREATE TABLE "target_budgets" (
	"target_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sessions" smallint NOT NULL,
	"cards" smallint NOT NULL,
	"miss_room" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_budgets_pkey" PRIMARY KEY("target_id","day")
);
--> statement-breakpoint
CREATE TABLE "target_readiness" (
	"target_id" uuid NOT NULL,
	"gloss_id" text NOT NULL,
	"dimension" text NOT NULL,
	"stability" real NOT NULL,
	"difficulty" real NOT NULL,
	"last_day" date NOT NULL,
	"reps" integer NOT NULL,
	"lapses" integer NOT NULL,
	"params" text NOT NULL,
	"day" date NOT NULL,
	"missed_today" boolean NOT NULL,
	"bonus_used" smallint NOT NULL,
	"held" boolean NOT NULL,
	"session_id" uuid,
	CONSTRAINT "target_readiness_pkey" PRIMARY KEY("target_id","gloss_id","dimension"),
	CONSTRAINT "target_readiness_dimension_known" CHECK ("target_readiness"."dimension" in ('written_productive', 'spelling', 'spoken_productive')),
	CONSTRAINT "target_readiness_bonus_range" CHECK ("target_readiness"."bonus_used" between 0 and 2),
	CONSTRAINT "target_readiness_stability_positive" CHECK ("target_readiness"."stability" > 0)
);
--> statement-breakpoint
CREATE TABLE "target_readiness_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"gloss_id" text NOT NULL,
	"dimension" text NOT NULL,
	"session_id" uuid NOT NULL,
	"day" date NOT NULL,
	"before" real NOT NULL,
	"after" real NOT NULL,
	"why" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_readiness_events_dimension_known" CHECK ("target_readiness_events"."dimension" in ('written_productive', 'spelling', 'spoken_productive')),
	CONSTRAINT "target_readiness_events_why_known" CHECK ("target_readiness_events"."why" in ('first_right', 'first_miss', 'miss', 'bonus'))
);
--> statement-breakpoint
ALTER TABLE "target_budgets" ADD CONSTRAINT "target_budgets_target_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_readiness" ADD CONSTRAINT "target_readiness_word_fk" FOREIGN KEY ("target_id","gloss_id") REFERENCES "public"."target_words"("target_id","gloss_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "target_readiness_events" ADD CONSTRAINT "target_readiness_events_target_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "target_readiness_events_target_day_idx" ON "target_readiness_events" USING btree ("target_id","day");
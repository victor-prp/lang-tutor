CREATE TABLE "pronunciation_scores" (
	"language_code" varchar(10) NOT NULL,
	"form_a" text NOT NULL,
	"form_b" text NOT NULL,
	"score" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pronunciation_scores_pkey" PRIMARY KEY("language_code","form_a","form_b"),
	CONSTRAINT "pronunciation_scores_ordered" CHECK ("pronunciation_scores"."form_a" < "pronunciation_scores"."form_b" collate "C"),
	CONSTRAINT "pronunciation_scores_form_a_length" CHECK (length("pronunciation_scores"."form_a") between 1 and 100),
	CONSTRAINT "pronunciation_scores_form_b_length" CHECK (length("pronunciation_scores"."form_b") between 1 and 100),
	CONSTRAINT "pronunciation_scores_score_range" CHECK ("pronunciation_scores"."score" between 0 and 1)
);

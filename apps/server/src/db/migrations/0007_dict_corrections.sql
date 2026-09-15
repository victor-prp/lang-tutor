-- Additive: dict_corrections is a new table with no prior rows to reconcile, so
-- this runs directly on the database phase 12 already truncated and backfills
-- nothing.
CREATE TABLE "dict_corrections" (
	"language_code" varchar(10) NOT NULL,
	"typed_form" text NOT NULL,
	"corrected_form" text NOT NULL,
	"alternatives" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dict_corrections_typed_form_length" CHECK (length("dict_corrections"."typed_form") between 1 and 100),
	CONSTRAINT "dict_corrections_corrected_form_length" CHECK (length("dict_corrections"."corrected_form") between 1 and 100),
	CONSTRAINT "dict_corrections_alternatives_valid" CHECK (correction_alternatives_valid("dict_corrections"."alternatives"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dict_corrections_form_key" ON "dict_corrections" USING btree ("language_code",lower("typed_form"));

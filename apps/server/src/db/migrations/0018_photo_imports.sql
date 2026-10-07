CREATE TABLE "photo_import_items" (
	"import_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"hebrew" text,
	"status" text NOT NULL,
	"corrected_form" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_sense_id" text,
	"chosen_sense_id" text,
	"ticked" boolean DEFAULT false NOT NULL,
	"hebrew_mismatch" boolean DEFAULT false NOT NULL,
	"reason" text,
	CONSTRAINT "photo_import_items_pkey" PRIMARY KEY("import_id","position"),
	CONSTRAINT "photo_import_items_status_known" CHECK ("photo_import_items"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "photo_import_items_reason_known" CHECK ("photo_import_items"."reason" is null or "photo_import_items"."reason" in ('sentence', 'no_meaning', 'not_in_language')),
	CONSTRAINT "photo_import_items_tick_needs_sense" CHECK (not "photo_import_items"."ticked" or "photo_import_items"."chosen_sense_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "photo_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" text NOT NULL,
	"status" text NOT NULL,
	"photo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_imports_status_known" CHECK ("photo_imports"."status" in ('reading', 'read', 'failed', 'saved', 'discarded')),
	CONSTRAINT "photo_imports_photo_only_while_reading" CHECK ("photo_imports"."photo" is null or "photo_imports"."status" = 'reading')
);
--> statement-breakpoint
ALTER TABLE "photo_import_items" ADD CONSTRAINT "photo_import_items_import_fk" FOREIGN KEY ("import_id") REFERENCES "public"."photo_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_imports" ADD CONSTRAINT "photo_imports_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_imports_enrollment_created_idx" ON "photo_imports" USING btree ("enrollment_id","created_at");
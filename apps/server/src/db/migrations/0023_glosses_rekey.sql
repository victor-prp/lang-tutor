-- Phase 31 (spec §2, migration steps 4-6). Every learner table names a gloss
-- instead of a sense. Hand-written (drizzle-kit generate --custom): drizzle reads
-- a dropped sense_id beside a new gloss_id as a possible rename and stops to ask.
-- 0022_glosses gave every rendered sense a gloss in each language it is rendered
-- in, which is what each fill below joins through.
ALTER TABLE "vocabulary_entries" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "sense_progress" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "session_progress" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "gloss_id" text;--> statement-breakpoint
ALTER TABLE "photo_import_items" ADD COLUMN "suggested_gloss_id" text;--> statement-breakpoint
ALTER TABLE "photo_import_items" ADD COLUMN "chosen_gloss_id" text;--> statement-breakpoint
-- Each row's gloss, through the membership in the language the row is about.
UPDATE "vocabulary_entries" ve SET "gloss_id" = m."gloss_id"
  FROM "enrollments" e, "dict_sense_glosses" m
  WHERE e."id" = ve."enrollment_id" AND m."sense_id" = ve."sense_id"
    AND m."user_language_code" = e."source_language";--> statement-breakpoint
UPDATE "sense_progress" p SET "gloss_id" = ve."gloss_id"
  FROM "vocabulary_entries" ve
  WHERE ve."enrollment_id" = p."enrollment_id" AND ve."sense_id" = p."sense_id";--> statement-breakpoint
UPDATE "session_progress" sp SET "gloss_id" = m."gloss_id"
  FROM "sessions" s, "enrollments" e, "dict_sense_glosses" m
  WHERE s."id" = sp."session_id" AND e."id" = s."enrollment_id"
    AND m."sense_id" = sp."sense_id" AND m."user_language_code" = e."source_language";--> statement-breakpoint
UPDATE "questions" q SET "gloss_id" = m."gloss_id"
  FROM "dict_sense_glosses" m
  WHERE m."sense_id" = q."sense_id" AND m."user_language_code" = q."user_language_code";--> statement-breakpoint
UPDATE "photo_import_items" i SET
    "suggested_gloss_id" = (SELECT m."gloss_id" FROM "photo_imports" pi
                              JOIN "enrollments" e ON e."id" = pi."enrollment_id"
                              JOIN "dict_sense_glosses" m ON m."sense_id" = i."suggested_sense_id"
                                                         AND m."user_language_code" = e."source_language"
                              WHERE pi."id" = i."import_id"),
    "chosen_gloss_id" = (SELECT m."gloss_id" FROM "photo_imports" pi
                           JOIN "enrollments" e ON e."id" = pi."enrollment_id"
                           JOIN "dict_sense_glosses" m ON m."sense_id" = i."chosen_sense_id"
                                                      AND m."user_language_code" = e."source_language"
                           WHERE pi."id" = i."import_id");--> statement-breakpoint
-- A photo row's options become gloss cards (spec D15): one per gloss, in the
-- order of its first option, with every member's example.
UPDATE "photo_import_items" i SET "options" = coalesce((
    SELECT jsonb_agg(o."card" ORDER BY o."first")
    FROM (
      SELECT min(x."ord") AS "first",
             jsonb_strip_nulls(jsonb_build_object(
               'gloss_id', m."gloss_id",
               'variant_id', (array_agg(x."opt"->>'variant_id' ORDER BY x."ord"))[1],
               'translation', (array_agg(x."opt"->>'translation' ORDER BY x."ord"))[1],
               'part_of_speech', (array_agg(x."opt"->>'part_of_speech' ORDER BY x."ord"))[1],
               'examples', jsonb_agg(x."opt"->'example' ORDER BY x."ord") FILTER (WHERE x."opt" ? 'example')
             )) AS "card"
      FROM jsonb_array_elements(i."options") WITH ORDINALITY AS x("opt", "ord")
      JOIN "photo_imports" pi ON pi."id" = i."import_id"
      JOIN "enrollments" e ON e."id" = pi."enrollment_id"
      JOIN "dict_sense_glosses" m ON m."sense_id" = x."opt"->>'sense_id' AND m."user_language_code" = e."source_language"
      GROUP BY m."gloss_id"
    ) o
  ), '[]'::jsonb)
  WHERE jsonb_array_length(i."options") > 0;--> statement-breakpoint
-- Spec D3 and done-means 4. A learner who saved two senses of one gloss keeps
-- one entry, the earliest save with its form and its adder, at each dimension's
-- highest level with the later dates (mergeLevels, domain/glosses.ts). The
-- progress folds first, onto the kept entry's rows, while both entries exist.
UPDATE "sense_progress" p SET
    "level" = f."level", "last_step_on" = f."last_step_on", "last_wrong_on" = f."last_wrong_on"
  FROM (
    SELECT "enrollment_id", "gloss_id", "dimension", max("level") AS "level",
           max("last_step_on") AS "last_step_on", max("last_wrong_on") AS "last_wrong_on"
    FROM "sense_progress" GROUP BY "enrollment_id", "gloss_id", "dimension" HAVING count(*) > 1
  ) f,
  (
    SELECT DISTINCT ON ("enrollment_id", "gloss_id") "enrollment_id", "gloss_id", "sense_id"
    FROM "vocabulary_entries" ORDER BY "enrollment_id", "gloss_id", "created_at", "sense_id"
  ) kept
  WHERE p."enrollment_id" = f."enrollment_id" AND p."gloss_id" = f."gloss_id" AND p."dimension" = f."dimension"
    AND kept."enrollment_id" = p."enrollment_id" AND kept."sense_id" = p."sense_id";--> statement-breakpoint
-- The other entries go, and their progress rows with them (sense_progress_entry_fk cascades).
DELETE FROM "vocabulary_entries" ve
  USING (
    SELECT DISTINCT ON ("enrollment_id", "gloss_id") "enrollment_id", "gloss_id", "sense_id"
    FROM "vocabulary_entries" ORDER BY "enrollment_id", "gloss_id", "created_at", "sense_id"
  ) kept
  WHERE kept."enrollment_id" = ve."enrollment_id" AND kept."gloss_id" = ve."gloss_id"
    AND kept."sense_id" <> ve."sense_id";--> statement-breakpoint
-- A session that practised two senses of one gloss: one row per dimension, the
-- lowest level before and the highest after (mergeSnapshots), which keeps
-- session_progress_levels_valid true. Lane 0 has 16 such sessions.
UPDATE "session_progress" sp SET "level_before" = f."level_before", "level_after" = f."level_after"
  FROM (
    SELECT "session_id", "gloss_id", "dimension", min("level_before") AS "level_before",
           max("level_after") AS "level_after", min("sense_id") AS "kept"
    FROM "session_progress" GROUP BY "session_id", "gloss_id", "dimension" HAVING count(*) > 1
  ) f
  WHERE sp."session_id" = f."session_id" AND sp."gloss_id" = f."gloss_id"
    AND sp."dimension" = f."dimension" AND sp."sense_id" = f."kept";--> statement-breakpoint
DELETE FROM "session_progress" sp
  USING (
    SELECT "session_id", "gloss_id", "dimension", min("sense_id") AS "kept"
    FROM "session_progress" GROUP BY "session_id", "gloss_id", "dimension" HAVING count(*) > 1
  ) f
  WHERE sp."session_id" = f."session_id" AND sp."gloss_id" = f."gloss_id"
    AND sp."dimension" = f."dimension" AND sp."sense_id" <> f."kept";--> statement-breakpoint
-- The keys. The progress FK goes first: it depends on the entries' primary key.
ALTER TABLE "sense_progress" DROP CONSTRAINT "sense_progress_entry_fk";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" DROP CONSTRAINT "vocabulary_entries_pkey";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" DROP CONSTRAINT "vocabulary_entries_sense_fk";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_pkey" PRIMARY KEY("enrollment_id","gloss_id");--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_gloss_fk" FOREIGN KEY ("gloss_id","lexeme_id") REFERENCES "public"."dict_glosses"("id","lexeme_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sense_progress" RENAME TO "gloss_progress";--> statement-breakpoint
ALTER TABLE "gloss_progress" DROP CONSTRAINT "sense_progress_pkey";--> statement-breakpoint
-- Dropping the column drops sense_progress_enrollment_dimension_idx with it.
ALTER TABLE "gloss_progress" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "gloss_progress" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "gloss_progress" ADD CONSTRAINT "gloss_progress_pkey" PRIMARY KEY("enrollment_id","gloss_id","dimension");--> statement-breakpoint
ALTER TABLE "gloss_progress" ADD CONSTRAINT "gloss_progress_entry_fk" FOREIGN KEY ("enrollment_id","gloss_id") REFERENCES "public"."vocabulary_entries"("enrollment_id","gloss_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gloss_progress" RENAME CONSTRAINT "sense_progress_dimension_known" TO "gloss_progress_dimension_known";--> statement-breakpoint
ALTER TABLE "gloss_progress" RENAME CONSTRAINT "sense_progress_level_range" TO "gloss_progress_level_range";--> statement-breakpoint
CREATE INDEX "gloss_progress_enrollment_dimension_idx" ON "gloss_progress" USING btree ("enrollment_id","dimension","gloss_id","level");--> statement-breakpoint
ALTER TABLE "session_progress" DROP CONSTRAINT "session_progress_pkey";--> statement-breakpoint
ALTER TABLE "session_progress" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "session_progress" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "session_progress" ADD CONSTRAINT "session_progress_pkey" PRIMARY KEY("session_id","gloss_id","dimension");--> statement-breakpoint
ALTER TABLE "questions" DROP CONSTRAINT "questions_sense_id_dict_senses_id_fk";--> statement-breakpoint
ALTER TABLE "questions" DROP COLUMN "sense_id";--> statement-breakpoint
ALTER TABLE "questions" ALTER COLUMN "gloss_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_gloss_fk" FOREIGN KEY ("gloss_id") REFERENCES "public"."dict_glosses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_import_items" DROP CONSTRAINT "photo_import_items_tick_needs_sense";--> statement-breakpoint
ALTER TABLE "photo_import_items" DROP COLUMN "suggested_sense_id";--> statement-breakpoint
ALTER TABLE "photo_import_items" DROP COLUMN "chosen_sense_id";--> statement-breakpoint
ALTER TABLE "photo_import_items" ADD CONSTRAINT "photo_import_items_tick_needs_gloss" CHECK (not "photo_import_items"."ticked" or "photo_import_items"."chosen_gloss_id" is not null);--> statement-breakpoint
ALTER TABLE "dict_var_translations" DROP COLUMN "definition_notes";

-- Phase 31 (spec §2, migration steps 1-3). The dictionary side of glosses:
-- one gloss per (lexeme, learner language, target word), one membership per
-- rendered sense, and one translation per rendering. Learner tables are
-- re-keyed in 0023_glosses_rekey; drizzle applies both in one transaction.
CREATE TABLE "dict_glosses" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"lexeme_id" text NOT NULL,
	"user_language_code" varchar(10) NOT NULL,
	"key" text NOT NULL,
	"alternatives" text[] DEFAULT '{}'::text[] NOT NULL,
	"merged_into" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dict_glosses_id_lexeme_key" UNIQUE("id","lexeme_id"),
	CONSTRAINT "dict_glosses_not_self" CHECK ("dict_glosses"."merged_into" is null or "dict_glosses"."merged_into" <> "dict_glosses"."id")
);
--> statement-breakpoint
CREATE TABLE "dict_sense_glosses" (
	"sense_id" text NOT NULL,
	"lexeme_id" text NOT NULL,
	"user_language_code" varchar(10) NOT NULL,
	"gloss_id" text NOT NULL,
	CONSTRAINT "dict_sense_glosses_pkey" PRIMARY KEY("sense_id","user_language_code")
);
--> statement-breakpoint
ALTER TABLE "dict_senses" ADD COLUMN "definition" text;--> statement-breakpoint
ALTER TABLE "dict_senses" ADD CONSTRAINT "dict_senses_id_lexeme_key" UNIQUE("id","lexeme_id");--> statement-breakpoint
ALTER TABLE "dict_var_translations" ADD COLUMN "gloss" text;--> statement-breakpoint
ALTER TABLE "dict_var_translations" ADD COLUMN "alternatives" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "dict_glosses" ADD CONSTRAINT "dict_glosses_lexeme_fk" FOREIGN KEY ("lexeme_id") REFERENCES "public"."dict_lexemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dict_glosses" ADD CONSTRAINT "dict_glosses_merged_into_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."dict_glosses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dict_sense_glosses" ADD CONSTRAINT "dict_sense_glosses_sense_fk" FOREIGN KEY ("sense_id","lexeme_id") REFERENCES "public"."dict_senses"("id","lexeme_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dict_sense_glosses" ADD CONSTRAINT "dict_sense_glosses_gloss_fk" FOREIGN KEY ("gloss_id","lexeme_id") REFERENCES "public"."dict_glosses"("id","lexeme_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dict_glosses_live_key" ON "dict_glosses" USING btree ("lexeme_id","user_language_code",gloss_key("key")) WHERE "dict_glosses"."merged_into" is null;--> statement-breakpoint
CREATE INDEX "dict_glosses_language_key_idx" ON "dict_glosses" USING btree ("user_language_code",gloss_key("key")) WHERE "dict_glosses"."merged_into" is null;--> statement-breakpoint
CREATE INDEX "dict_sense_glosses_gloss_idx" ON "dict_sense_glosses" USING btree ("gloss_id");--> statement-breakpoint
CREATE INDEX "dict_sense_glosses_lexeme_idx" ON "dict_sense_glosses" USING btree ("lexeme_id","user_language_code");
--> statement-breakpoint
-- Step 2. One translation per rendering. Parentheticals go first, then the list
-- marks split; the first item is the translation and the gloss, the next five
-- distinct by gloss_key the alternatives. The SQL twin of splitTranslation in
-- domain/glosses.ts; the migration test runs lane 0's shapes through both.
UPDATE "dict_var_translations" tr
SET "translation" = c."items"[1],
    "gloss" = c."items"[1],
    "alternatives" = ARRAY(
      SELECT d."item" FROM (
        SELECT DISTINCT ON (gloss_key(x."item")) x."item", x."n"
        FROM unnest(c."items"[2:]) WITH ORDINALITY AS x("item", "n")
        WHERE gloss_key(x."item") <> gloss_key(c."items"[1]) AND gloss_key(x."item") <> ''
        ORDER BY gloss_key(x."item"), x."n"
      ) d
      ORDER BY d."n"
      LIMIT 5
    )
FROM (
  SELECT t."variant_id", t."sense_id", t."user_language_code",
         ARRAY(
           SELECT btrim(regexp_replace(u."item", '\s+', ' ', 'g'))
           FROM unnest(regexp_split_to_array(regexp_replace(t."translation", '\([^)]*\)', '', 'g'), '[,/;]'))
                WITH ORDINALITY AS u("item", "n")
           WHERE btrim(regexp_replace(u."item", '\s+', ' ', 'g')) <> ''
           ORDER BY u."n"
         ) AS "items"
  FROM "dict_var_translations" t
) c
WHERE tr."variant_id" = c."variant_id" AND tr."sense_id" = c."sense_id"
  AND tr."user_language_code" = c."user_language_code" AND cardinality(c."items") > 0;--> statement-breakpoint
-- A translation that was nothing but a parenthetical stays, tidied.
UPDATE "dict_var_translations"
SET "translation" = btrim(regexp_replace("translation", '\s+', ' ', 'g')),
    "gloss" = btrim(regexp_replace("translation", '\s+', ' ', 'g'))
WHERE "gloss" IS NULL;--> statement-breakpoint
ALTER TABLE "dict_var_translations" ALTER COLUMN "gloss" SET NOT NULL;--> statement-breakpoint
-- Step 3. One gloss per (lexeme, learner language, key). A sense's key is the
-- translation of its lemma-form rendering in that language, else of its
-- lowest-ranked rendering; the gloss is spelled as its lowest-ranked member wrote it.
INSERT INTO "dict_glosses" ("lexeme_id", "user_language_code", "key")
SELECT DISTINCT ON (k."lexeme_id", k."user_language_code", gloss_key(k."key"))
       k."lexeme_id", k."user_language_code", k."key"
FROM (
  SELECT DISTINCT ON (s."id", tr."user_language_code")
         s."id" AS "sense_id", s."lexeme_id", tr."user_language_code", tr."translation" AS "key", tr."rank"
  FROM "dict_senses" s
  JOIN "dict_var_translations" tr ON tr."sense_id" = s."id"
  JOIN "dict_variants" v ON v."id" = tr."variant_id"
  JOIN "dict_lexemes" l ON l."id" = s."lexeme_id"
  ORDER BY s."id", tr."user_language_code", (lower(v."form") = lower(l."lemma")) DESC, tr."rank", v."id"
) k
ORDER BY k."lexeme_id", k."user_language_code", gloss_key(k."key"), k."rank", k."sense_id";--> statement-breakpoint
INSERT INTO "dict_sense_glosses" ("sense_id", "lexeme_id", "user_language_code", "gloss_id")
SELECT k."sense_id", k."lexeme_id", k."user_language_code", g."id"
FROM (
  SELECT DISTINCT ON (s."id", tr."user_language_code")
         s."id" AS "sense_id", s."lexeme_id", tr."user_language_code", tr."translation" AS "key"
  FROM "dict_senses" s
  JOIN "dict_var_translations" tr ON tr."sense_id" = s."id"
  JOIN "dict_variants" v ON v."id" = tr."variant_id"
  JOIN "dict_lexemes" l ON l."id" = s."lexeme_id"
  ORDER BY s."id", tr."user_language_code", (lower(v."form") = lower(l."lemma")) DESC, tr."rank", v."id"
) k
JOIN "dict_glosses" g ON g."lexeme_id" = k."lexeme_id" AND g."user_language_code" = k."user_language_code"
                     AND gloss_key(g."key") = gloss_key(k."key");--> statement-breakpoint
-- A gloss's alternatives: its members' lemma-form alternatives, distinct by
-- gloss_key, never its key, at most five (spec §2, step 3).
UPDATE "dict_glosses" g
SET "alternatives" = ARRAY(
  SELECT d."alt" FROM (
    SELECT DISTINCT ON (gloss_key(a."alt")) a."alt", a."rank"
    FROM (
      SELECT x."alt", tr."rank"
      FROM "dict_sense_glosses" m
      JOIN "dict_var_translations" tr ON tr."sense_id" = m."sense_id" AND tr."user_language_code" = m."user_language_code"
      JOIN "dict_variants" v ON v."id" = tr."variant_id"
      JOIN "dict_lexemes" l ON l."id" = v."lexeme_id" AND lower(v."form") = lower(l."lemma")
      CROSS JOIN LATERAL unnest(tr."alternatives") AS x("alt")
      WHERE m."gloss_id" = g."id"
    ) a
    WHERE gloss_key(a."alt") <> gloss_key(g."key")
    ORDER BY gloss_key(a."alt"), a."rank"
  ) d
  ORDER BY d."rank"
  LIMIT 5
);

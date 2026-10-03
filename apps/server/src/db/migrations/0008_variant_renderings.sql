-- Phase 16. One rendering counter per (variant, explanation language) instead
-- of one per variant. Backfilled before the old column is dropped: every
-- variant gets one row per language it has translations in, carrying the
-- version the single counter held — exact today, because before phase 16 every
-- variant was rendered in exactly one language.
CREATE TABLE "dict_variant_renderings" (
	"variant_id" text NOT NULL,
	"user_language_code" varchar(10) NOT NULL,
	"rendered_sense_version" integer NOT NULL,
	CONSTRAINT "dict_variant_renderings_pkey" PRIMARY KEY("variant_id","user_language_code")
);
--> statement-breakpoint
ALTER TABLE "dict_variant_renderings" ADD CONSTRAINT "dict_variant_renderings_variant_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."dict_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "dict_variant_renderings" ("variant_id", "user_language_code", "rendered_sense_version")
SELECT DISTINCT tr."variant_id", tr."user_language_code", v."rendered_sense_version"
FROM "dict_var_translations" tr
JOIN "dict_variants" v ON v."id" = tr."variant_id";--> statement-breakpoint
ALTER TABLE "dict_variants" DROP COLUMN "rendered_sense_version";
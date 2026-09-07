WITH numbered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n
  FROM "users" WHERE "username" IS NULL
)
UPDATE "users" SET "username" = 'legacy_' || numbered.n
FROM numbered WHERE "users"."id" = numbered."id";
--> statement-breakpoint
UPDATE "users" SET "display_name" = "username" WHERE "display_name" IS NULL;
--> statement-breakpoint
UPDATE "users" SET "age" = 30 WHERE "age" IS NULL;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "native_language" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "target_language" DROP DEFAULT;

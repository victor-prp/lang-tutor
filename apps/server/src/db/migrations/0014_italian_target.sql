-- Phase 22. Italian is a language to learn, so the enrollment target check
-- widens. No row changes, and no other column constrains a language code.
ALTER TABLE "enrollments" DROP CONSTRAINT "enrollments_target_known";--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_target_known" CHECK ("enrollments"."target_language" in ('he', 'en', 'ru', 'it'));
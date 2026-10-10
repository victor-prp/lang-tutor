-- Phase 31. Lemma-form render requests (plan item 3).
CREATE TABLE "dict_lemma_renders" (
	"lexeme_id" text NOT NULL,
	"user_language_code" varchar(10) NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dict_lemma_renders_pkey" PRIMARY KEY("lexeme_id","user_language_code")
);
--> statement-breakpoint
ALTER TABLE "dict_lemma_renders" ADD CONSTRAINT "dict_lemma_renders_lexeme_fk" FOREIGN KEY ("lexeme_id") REFERENCES "public"."dict_lexemes"("id") ON DELETE cascade ON UPDATE no action;
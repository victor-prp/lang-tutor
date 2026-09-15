ALTER TABLE dict_lexemes  ADD COLUMN sense_version           integer NOT NULL DEFAULT 0;
ALTER TABLE dict_variants ADD COLUMN rendered_sense_version  integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE dict_lexemes l
   SET sense_version = (SELECT count(*) FROM dict_senses s WHERE s.lexeme_id = l.id);
--> statement-breakpoint
UPDATE dict_variants v
   SET rendered_sense_version = (SELECT l.sense_version FROM dict_lexemes l WHERE l.id = v.lexeme_id);

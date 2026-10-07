import { sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import { createVocabularyRepo } from '../../src/repo/vocabulary';
import { insertLexeme } from './dictRows';
import { withTx } from './withTx';

/**
 * One lexeme with one form rendering each translation as its own sense, every
 * sense saved into `enrollmentId`. Tests about list sessions need saved words
 * without driving the translate flow; this is that, in one call.
 */
export async function seedSavedSenses(
  db: Db,
  input: {
    enrollmentId: string;
    lemma: string;
    translations: string[];
    form?: string;
    languageCode?: string;
    /** Who saved them; the enrollment's owner when omitted. */
    addedByUserId?: string;
    /** Phase 27: the saved example of the first sense's rendering. */
    example?: { source: string; target: string };
  },
): Promise<{ lexemeId: string; variantId: string; senseIds: string[] }> {
  const word = await insertLexeme(db, {
    lemma: input.lemma,
    languageCode: input.languageCode ?? 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: input.translations.map((_, i) => ({ senseCode: `s${i}` })),
    variants: [
      {
        form: input.form ?? input.lemma,
        kind: 'word',
        entryRank: 0,
        translations: input.translations.map((translation, i) => ({
          senseCode: `s${i}`,
          rank: i,
          translation,
          exampleSource: i === 0 ? (input.example?.source ?? null) : null,
          exampleTarget: i === 0 ? (input.example?.target ?? null) : null,
        })),
      },
    ],
  });
  const variantId = word.variantIds[0];
  const addedByUserId = input.addedByUserId ?? (await ownerOf(db, input.enrollmentId));
  // Through the repository, so each entry gets its five progress rows exactly
  // as a real save writes them.
  await withTx(db, (tx) =>
    createVocabularyRepo(tx).insertEntries({
      enrollmentId: input.enrollmentId,
      addedByUserId,
      entries: word.senseIds.map((senseId) => ({ senseId, variantId, lexemeId: word.lexemeId, lemma: input.lemma })),
    }),
  );
  return { lexemeId: word.lexemeId, variantId, senseIds: word.senseIds };
}

export async function ownerOf(db: Db, enrollmentId: string): Promise<string> {
  const rows = await db.execute<{ user_id: string }>(sql`select user_id from enrollments where id = ${enrollmentId}`);
  if (rows.rows.length === 0) throw new Error(`no enrollment ${enrollmentId}`);
  return rows.rows[0].user_id;
}

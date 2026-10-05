import type { Db } from '../../src/db/client';
import { vocabularyEntries } from '../../src/db/schema';
import { insertLexeme } from './dictRows';

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
          exampleSource: null,
          exampleTarget: null,
        })),
      },
    ],
  });
  const variantId = word.variantIds[0];
  await db.insert(vocabularyEntries).values(
    word.senseIds.map((senseId) => ({
      enrollmentId: input.enrollmentId,
      senseId,
      lexemeId: word.lexemeId,
      variantId,
    })),
  );
  return { lexemeId: word.lexemeId, variantId, senseIds: word.senseIds };
}

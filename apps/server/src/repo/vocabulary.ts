import { and, asc, eq, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { termSenseTranslations, termVariants, vocabTermSenses } from '../db/schema';
import type { SenseRow } from '../domain/vocabulary';

// The response cap. The database has no five limit — `see` keeps all its
// senses and `saw` all of its — so this truncates the merge and nothing else,
// which is why a later lookup of `see` returns its full entry rather than
// whatever slice fitted alongside `saw`.
const READ_LIMIT = 5;

export function createVocabRepo(tx: Tx) {
  /**
   * Three tables, driven by the unique index's (language_code, lower(form))
   * prefix, with no join to `vocab_terms` at all — language and the ordering
   * key both live on the variant now.
   *
   * The inner join to `term_sense_translations` *is* the servability test: a
   * term with no translation in the language being asked for returns zero rows,
   * which the service reads as a miss. No column and no flag.
   *
   * `(s.rank, v.entry_rank)` is unique across one form's rows and `v.term_id`
   * closes it, so identical requests return identical answers — forever.
   */
  const findSensesByForm = async (input: {
    form: string;
    languageCode: string;
    userLanguageCode: string;
  }): Promise<SenseRow[]> =>
    tx
      .select({
        termId: termVariants.termId,
        rank: vocabTermSenses.rank,
        entryRank: termVariants.entryRank,
        partOfSpeech: vocabTermSenses.partOfSpeech,
        exampleSource: vocabTermSenses.exampleSource,
        translation: termSenseTranslations.translation,
        exampleTarget: termSenseTranslations.exampleTarget,
      })
      .from(termVariants)
      .innerJoin(vocabTermSenses, eq(vocabTermSenses.termId, termVariants.termId))
      .innerJoin(
        termSenseTranslations,
        and(
          eq(termSenseTranslations.senseId, vocabTermSenses.id),
          eq(termSenseTranslations.userLanguageCode, input.userLanguageCode),
        ),
      )
      .where(
        and(
          eq(termVariants.languageCode, input.languageCode),
          // lower(form), matching the index expression exactly so the index is
          // usable. Hebrew has no case, so this is a no-op on that side.
          sql`lower(${termVariants.form}) = ${input.form.toLowerCase()}`,
        ),
      )
      // Rank leads, so the merge across headwords is round-robin rather than
      // block-per-entry: ordering by entry first would put all of `see`'s
      // senses ahead of `saw`'s, and a five-sense `see` would push `מסור` off
      // the cap entirely.
      .orderBy(asc(vocabTermSenses.rank), asc(termVariants.entryRank), asc(termVariants.termId))
      .limit(READ_LIMIT);

  return { findSensesByForm };
}

export type VocabRepo = ReturnType<typeof createVocabRepo>;

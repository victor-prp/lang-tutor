import { asc, eq, sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { dictLexemes, vocabularyEntries } from '../db/schema';
import type {
  LexemeRendering,
  LexemeRow,
  SavedEntry,
  VocabularyCursor,
  WordPageRow,
  WordSummary,
} from '../domain/vocabulary';

/** A pair that passed `findSaveable`, carrying the lexeme id the entry copies. */
export type SaveableEntry = { senseId: string; variantId: string; lexemeId: string };

// `IN (...)` from a list. Every caller guards the empty list first: `IN ()` is a
// syntax error, and an empty list has an obvious answer that needs no query.
const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * Every statement the hot paths of this repository run, as a builder. Exported so
 * tests/integration/repo/vocabulary.plan.test.ts can EXPLAIN exactly these
 * statements at volume: a plan test of hand-copied SQL would prove something
 * about a query nobody runs.
 *
 * Every one is scoped to ONE enrollment or ONE lexeme and served by an index
 * leading with it — that is what keeps the table's total size irrelevant (spec
 * §3, "Cost of every query").
 */
export const vocabularyQueries = {
  /** Save: a primary-key insert. Named conflict target, not bare: only the PK
   *  may be swallowed, so an FK violation still raises. First form wins — a
   *  sense already saved keeps the variant it was saved from. */
  insertEntries: (input: { enrollmentId: string; entries: SaveableEntry[] }): SQL => sql`
    INSERT INTO vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
    VALUES ${sql.join(
      input.entries.map(
        (e) => sql`(${input.enrollmentId}, ${e.senseId}, ${e.lexemeId}, ${e.variantId})`,
      ),
      sql`, `,
    )}
    ON CONFLICT (enrollment_id, sense_id) DO NOTHING`,

  /** Unsave: a primary-key delete. */
  deleteEntry: (input: { enrollmentId: string; senseId: string }): SQL => sql`
    DELETE FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND sense_id = ${input.senseId}`,

  /** Which asked pairs may be saved: the sense's lexeme is in the target
   *  language, the variant belongs to that lexeme, and the variant renders the
   *  sense in the source language. PK lookups throughout. */
  saveable: (input: {
    entries: { senseId: string; variantId: string }[];
    targetLanguage: string;
    sourceLanguage: string;
  }): SQL => sql`
    SELECT s.id AS sense_id, v.id AS variant_id, l.id AS lexeme_id
    FROM (VALUES ${sql.join(
      input.entries.map((e) => sql`(${e.senseId}::text, ${e.variantId}::text)`),
      sql`, `,
    )}) AS asked(sense_id, variant_id)
    JOIN dict_senses s            ON s.id = asked.sense_id
    JOIN dict_lexemes l           ON l.id = s.lexeme_id
                                 AND l.language_code = ${input.targetLanguage}
    JOIN dict_variants v          ON v.id = asked.variant_id
                                 AND v.lexeme_id = l.id
    JOIN dict_var_translations tr ON tr.variant_id = v.id
                                 AND tr.sense_id = s.id
                                 AND tr.user_language_code = ${input.sourceLanguage}`,

  /** The lookup's `saved` flags: point lookups on the primary key. */
  savedSenseIds: (input: { enrollmentId: string; senseIds: string[] }): SQL => sql`
    SELECT sense_id FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND sense_id IN (${inList(input.senseIds)})`,

  /**
   * One page of lexemes, newest save first. The grouping is an index-only scan
   * of this enrollment's slice of (enrollment_id, lexeme_id, created_at).
   *
   * The timestamp goes out as `::text` and comes back with `::timestamptz` —
   * microseconds intact; see VocabularyCursor. The row comparison is strictly
   * "after the cursor" in DESC order, so a word that moves to the top between
   * pages is never served twice.
   */
  wordsPage: (input: {
    enrollmentId: string;
    limit: number;
    after: VocabularyCursor | null;
  }): SQL => sql`
    SELECT lexeme_id, max(created_at)::text AS last_saved_at
    FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
    GROUP BY lexeme_id
    ${
      input.after
        ? sql`HAVING (max(created_at), lexeme_id) < (${input.after.savedAt}::timestamptz, ${input.after.lexemeId}::text)`
        : sql``
    }
    ORDER BY max(created_at) DESC, lexeme_id DESC
    LIMIT ${input.limit}`,

  /**
   * One row per lexeme of a page: the headline, the two counts. The LATERAL is
   * an INNER join on purpose — a word with no rendered saved sense has nothing
   * to headline and is dropped (assemblePage's comment).
   *
   * Headline: lowest rank in its own saved form, then the earliest save, then
   * sense id — deterministic, and all inside SQL so no timestamp crosses into
   * TypeScript.
   */
  wordSummaries: (input: {
    enrollmentId: string;
    lexemeIds: string[];
    sourceLanguage: string;
  }): SQL => sql`
    SELECT l.id AS lexeme_id, l.lemma, l.part_of_speech,
           h.sense_id AS headline_sense_id,
           h.translation AS headline_translation,
           h.form AS headline_form,
           (SELECT count(*) FROM vocabulary_entries c
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lexeme_id = l.id)::int AS saved_count,
           (SELECT count(*) FROM dict_senses s
             WHERE s.lexeme_id = l.id
               AND EXISTS (SELECT 1 FROM dict_var_translations r
                            WHERE r.sense_id = s.id
                              AND r.user_language_code = ${input.sourceLanguage}))::int AS sense_count
    FROM dict_lexemes l
    JOIN LATERAL (
      SELECT ve.sense_id, tr.translation, v.form
      FROM vocabulary_entries ve
      JOIN dict_var_translations tr ON tr.variant_id = ve.variant_id
                                   AND tr.sense_id = ve.sense_id
                                   AND tr.user_language_code = ${input.sourceLanguage}
      JOIN dict_variants v          ON v.id = ve.variant_id
      WHERE ve.enrollment_id = ${input.enrollmentId}
        AND ve.lexeme_id = l.id
      ORDER BY tr.rank, ve.created_at, ve.sense_id
      LIMIT 1
    ) h ON true
    WHERE l.id IN (${inList(input.lexemeIds)})`,

  /** Every rendering of one lexeme's senses in one language, by any form. */
  lexemeRenderings: (input: { lexemeId: string; userLanguageCode: string }): SQL => sql`
    SELECT tr.sense_id, tr.variant_id, v.form, tr.rank, tr.translation,
           tr.example_source, tr.example_target
    FROM dict_senses s
    JOIN dict_var_translations tr ON tr.sense_id = s.id
                                 AND tr.user_language_code = ${input.userLanguageCode}
    JOIN dict_variants v          ON v.id = tr.variant_id
    WHERE s.lexeme_id = ${input.lexemeId}`,

  /** One lexeme's saved senses in one enrollment. */
  savedInLexeme: (input: { enrollmentId: string; lexemeId: string }): SQL => sql`
    SELECT sense_id, variant_id FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND lexeme_id = ${input.lexemeId}`,
};

export function createVocabularyRepo(tx: Tx) {
  return {
    findSaveable: async (input: {
      entries: { senseId: string; variantId: string }[];
      targetLanguage: string;
      sourceLanguage: string;
    }): Promise<SaveableEntry[]> => {
      if (input.entries.length === 0) return [];
      const rows = await tx.execute<{ sense_id: string; variant_id: string; lexeme_id: string }>(
        vocabularyQueries.saveable(input),
      );
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        variantId: row.variant_id,
        lexemeId: row.lexeme_id,
      }));
    },

    /** First form wins: a sense already saved keeps the variant it was saved from. */
    insertEntries: async (input: { enrollmentId: string; entries: SaveableEntry[] }): Promise<void> => {
      if (input.entries.length === 0) return;
      await tx.execute(vocabularyQueries.insertEntries(input));
    },

    deleteEntry: async (input: { enrollmentId: string; senseId: string }): Promise<void> => {
      await tx.execute(vocabularyQueries.deleteEntry(input));
    },

    findSavedSenseIds: async (input: { enrollmentId: string; senseIds: string[] }): Promise<string[]> => {
      if (input.senseIds.length === 0) return [];
      const rows = await tx.execute<{ sense_id: string }>(vocabularyQueries.savedSenseIds(input));
      return rows.rows.map((row) => row.sense_id);
    },

    /** Every saved sense of one enrollment, for picking a list session. Bounded
     *  by what one person saves by hand. Ordered so a seeded rng picks
     *  reproducibly. */
    listSavedSenses: async (
      enrollmentId: string,
    ): Promise<{ senseId: string; variantId: string }[]> =>
      tx
        .select({ senseId: vocabularyEntries.senseId, variantId: vocabularyEntries.variantId })
        .from(vocabularyEntries)
        .where(eq(vocabularyEntries.enrollmentId, enrollmentId))
        .orderBy(asc(vocabularyEntries.senseId)),

    countEntries: async (enrollmentId: string): Promise<number> => {
      const rows = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM vocabulary_entries WHERE enrollment_id = ${enrollmentId}`,
      );
      return rows.rows[0].n;
    },

    findWordsPage: async (input: {
      enrollmentId: string;
      limit: number;
      after: VocabularyCursor | null;
    }): Promise<WordPageRow[]> => {
      const rows = await tx.execute<{ lexeme_id: string; last_saved_at: string }>(
        vocabularyQueries.wordsPage(input),
      );
      return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, lastSavedAt: row.last_saved_at }));
    },

    findWordSummaries: async (input: {
      enrollmentId: string;
      lexemeIds: string[];
      sourceLanguage: string;
    }): Promise<WordSummary[]> => {
      if (input.lexemeIds.length === 0) return [];
      const rows = await tx.execute<{
        lexeme_id: string;
        lemma: string;
        part_of_speech: string;
        headline_sense_id: string;
        headline_translation: string;
        headline_form: string;
        saved_count: number;
        sense_count: number;
      }>(vocabularyQueries.wordSummaries(input));
      return rows.rows.map((row) => ({
        lexemeId: row.lexeme_id,
        lemma: row.lemma,
        partOfSpeech: row.part_of_speech,
        headlineSenseId: row.headline_sense_id,
        headlineTranslation: row.headline_translation,
        headlineForm: row.headline_form,
        savedCount: row.saved_count,
        senseCount: row.sense_count,
      }));
    },

    findLexeme: async (lexemeId: string): Promise<LexemeRow | undefined> => {
      const [row] = await tx
        .select({
          lexemeId: dictLexemes.id,
          lemma: dictLexemes.lemma,
          partOfSpeech: dictLexemes.partOfSpeech,
          languageCode: dictLexemes.languageCode,
        })
        .from(dictLexemes)
        .where(eq(dictLexemes.id, lexemeId));
      return row;
    },

    findLexemeRenderings: async (input: {
      lexemeId: string;
      userLanguageCode: string;
    }): Promise<LexemeRendering[]> => {
      const rows = await tx.execute<{
        sense_id: string;
        variant_id: string;
        form: string;
        rank: number;
        translation: string;
        example_source: string | null;
        example_target: string | null;
      }>(vocabularyQueries.lexemeRenderings(input));
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        variantId: row.variant_id,
        form: row.form,
        rank: row.rank,
        translation: row.translation,
        exampleSource: row.example_source,
        exampleTarget: row.example_target,
      }));
    },

    findSavedInLexeme: async (input: { enrollmentId: string; lexemeId: string }): Promise<SavedEntry[]> => {
      const rows = await tx.execute<{ sense_id: string; variant_id: string }>(
        vocabularyQueries.savedInLexeme(input),
      );
      return rows.rows.map((row) => ({ senseId: row.sense_id, variantId: row.variant_id }));
    },
  };
}

export type VocabularyRepo = ReturnType<typeof createVocabularyRepo>;

import { DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';
import { sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type {
  LexemeRendering,
  SavedEntry,
  VocabularyCursor,
  WordLexeme,
  WordPageRow,
  WordSummary,
} from '../domain/vocabulary';

/** A pair that passed `findSaveable`, carrying the lexeme id and lemma the entry copies. */
export type SaveableEntry = { glossId: string; variantId: string; lexemeId: string; lemma: string };

// `IN (...)` from a list. `IN ()` is a syntax error, so a caller either guards an
// empty list first (an empty list has an obvious answer that needs no query) or
// passes a list that is never empty (wordsPage's LIVE_DIMENSIONS).
const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

// A word's badge: the rounded mean of its saved glosses' live-dimension levels,
// ties up. badge() in packages/core is the same arithmetic in TypeScript.
const LEVEL = sql`floor(avg(p.level) + 0.5)::int`;
const SAVED_AT = sql`max(ve.created_at)`;

/** Strictly after the cursor in the list's one order: newest save first, lemma
 *  descending on a tie. */
function afterCursor(after: VocabularyCursor): SQL {
  return sql`(${SAVED_AT}, ve.lemma) < (${after.savedAt}::timestamptz, ${after.lemma}::text)`;
}

/**
 * Every statement the hot paths of this repository run, as a builder. Exported so
 * tests/integration/repo/vocabulary.plan.test.ts can EXPLAIN exactly these
 * statements at volume: a plan test of hand-copied SQL would prove something
 * about a query nobody runs.
 *
 * Every one is scoped to ONE enrollment or ONE lemma and served by an index
 * leading with it — that is what keeps the table's total size irrelevant (spec
 * §3, "Cost of every query").
 */
export const vocabularyQueries = {
  /** Save: a primary-key insert, and the five progress rows of every entry it
   *  creates, in one statement. Named conflict target, not bare: only the PK
   *  may be swallowed, so an FK violation still raises. First form wins — a
   *  gloss already saved keeps its variant, and RETURNING leaves it out, so its
   *  progress is untouched. First adder wins, exactly as first form does: the
   *  conflict keeps the row, its form and its adder (spec D5). */
  insertEntries: (input: { enrollmentId: string; addedByUserId: string; entries: SaveableEntry[] }): SQL => sql`
    WITH inserted AS (
      INSERT INTO vocabulary_entries (enrollment_id, gloss_id, lexeme_id, lemma, variant_id, added_by_user_id)
      VALUES ${sql.join(
        input.entries.map(
          (e) =>
            sql`(${input.enrollmentId}, ${e.glossId}, ${e.lexemeId}, ${e.lemma}, ${e.variantId}, ${input.addedByUserId})`,
        ),
        sql`, `,
      )}
      ON CONFLICT (enrollment_id, gloss_id) DO NOTHING
      RETURNING enrollment_id, gloss_id
    )
    INSERT INTO gloss_progress (enrollment_id, gloss_id, dimension)
    SELECT i.enrollment_id, i.gloss_id, d.dimension
    FROM inserted i
    CROSS JOIN (VALUES ${sql.join(
      DIMENSIONS.map((dimension) => sql`(${dimension}::text)`),
      sql`, `,
    )}) AS d(dimension)`,

  /** Unsave: a primary-key delete. */
  deleteEntry: (input: { enrollmentId: string; glossId: string }): SQL => sql`
    DELETE FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND gloss_id = ${input.glossId}`,

  /** Which asked pairs may be saved (spec D2, D14): the gloss is live and in the
   *  enrollment's learner language, its lexeme is in the target language, and the
   *  variant is a form of that lexeme rendering one of the gloss's senses in the
   *  learner's language. Primary-key and index lookups throughout. */
  saveable: (input: {
    entries: { glossId: string; variantId: string }[];
    targetLanguage: string;
    sourceLanguage: string;
  }): SQL => sql`
    SELECT g.id AS gloss_id, v.id AS variant_id, l.id AS lexeme_id, l.lemma
    FROM (VALUES ${sql.join(
      input.entries.map((e) => sql`(${e.glossId}::text, ${e.variantId}::text)`),
      sql`, `,
    )}) AS asked(gloss_id, variant_id)
    JOIN dict_glosses g  ON g.id = asked.gloss_id
                        AND g.merged_into IS NULL
                        AND g.user_language_code = ${input.sourceLanguage}
    JOIN dict_lexemes l  ON l.id = g.lexeme_id
                        AND l.language_code = ${input.targetLanguage}
    JOIN dict_variants v ON v.id = asked.variant_id
                        AND v.lexeme_id = l.id
    WHERE EXISTS (
      SELECT 1 FROM dict_sense_glosses m
      JOIN dict_var_translations tr ON tr.sense_id = m.sense_id
                                   AND tr.user_language_code = m.user_language_code
                                   AND tr.variant_id = v.id
      WHERE m.gloss_id = g.id)`,

  /** The lookup's `saved` flags: point lookups on the primary key. */
  savedGlossIds: (input: { enrollmentId: string; glossIds: string[] }): SQL => sql`
    SELECT gloss_id FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND gloss_id IN (${inList(input.glossIds)})`,

  /**
   * One page of lemmas with their level, newest save first, optionally one level
   * only.
   *
   * Phase 23: the page comes first and the level second. `w` groups the
   * enrollment's entries by their own copy of the lemma (an index-only scan of
   * vocabulary_entries_enrollment_lemma_idx; no dictionary row is read) and sorts
   * them; the LATERAL then computes each lemma's level from its live-dimension
   * progress rows, through gloss_progress_enrollment_dimension_idx. `w`'s own
   * ORDER BY is what lets the outer LIMIT stop the nested loop early, so a page
   * costs about its own size: the first shape aggregated every progress row of
   * the enrollment before sorting, which tripled when three dimensions went
   * live. A level filter reads levels in save order until the page is full.
   *
   * The timestamp goes out as `::text` and comes back with `::timestamptz` —
   * microseconds intact; see VocabularyCursor. The comparison is strictly
   * "after the cursor". A word saved into again, in any of its lexemes, only
   * moves to the top, behind the cursor, so it is never served twice in one walk.
   */
  wordsPage: (input: {
    enrollmentId: string;
    limit: number;
    after: VocabularyCursor | null;
    level: number | null;
    live: readonly Dimension[];
  }): SQL => {
    // A lemma with no live-dimension progress rows gets a null level and drops
    // out of the list, while the detail reads the same entry as level 1
    // (glossProgressOf's fallback). Acceptable because it cannot happen today:
    // the only writer of entries (insertEntries) creates their rows in the same
    // statement, and the migration backfilled the older ones.
    return sql`
      SELECT w.lemma, w.last_saved_at::text AS last_saved_at, lv.level
      FROM (
        SELECT ve.lemma, ${SAVED_AT} AS last_saved_at
        FROM vocabulary_entries ve
        WHERE ve.enrollment_id = ${input.enrollmentId}
        GROUP BY ve.lemma
        ${input.after ? sql`HAVING ${afterCursor(input.after)}` : sql``}
        ORDER BY ${SAVED_AT} DESC, ve.lemma DESC
      ) w
      CROSS JOIN LATERAL (
        SELECT ${LEVEL} AS level
        FROM vocabulary_entries ve
        JOIN gloss_progress p ON p.enrollment_id = ve.enrollment_id
                             AND p.gloss_id = ve.gloss_id
                             AND p.dimension IN (${inList([...input.live])})
        WHERE ve.enrollment_id = ${input.enrollmentId}
          AND ve.lemma = w.lemma
      ) lv
      WHERE lv.level IS NOT NULL
        ${input.level !== null ? sql`AND lv.level = ${input.level}` : sql``}
      ORDER BY w.last_saved_at DESC, w.lemma DESC
      LIMIT ${input.limit}`;
  },

  /**
   * One row per lemma of a page: the headline, the saved parts of speech, the two
   * counts. The LATERAL is an INNER join on purpose — a word with no saved gloss
   * has nothing to headline and is dropped (assemblePage's comment).
   *
   * Headline: the earliest saved gloss of the lemma, across every lexeme, ties by
   * gloss id — deterministic, and all inside SQL so no timestamp crosses into
   * TypeScript. Both counts count glosses (spec D11): `saved_count` the saved
   * ones, `gloss_count` the live glosses of every lexeme with the lemma in the
   * target language, in the enrollment's learner language, found through
   * dict_lexemes_language_lemma_pos_key and dict_glosses_live_key. So `mouse`,
   * two senses and one gloss, reads 1 of 1 once saved.
   */
  wordSummaries: (input: {
    enrollmentId: string;
    lemmas: string[];
    targetLanguage: string;
    sourceLanguage: string;
    ownerUserId: string;
  }): SQL => sql`
    SELECT w.lemma,
           h.gloss_id AS headline_gloss_id,
           h.key AS headline_translation,
           h.form AS headline_form,
           (SELECT array_agg(DISTINCT l.part_of_speech ORDER BY l.part_of_speech)
              FROM vocabulary_entries c
              JOIN dict_lexemes l ON l.id = c.lexeme_id
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lemma = w.lemma) AS parts_of_speech,
           (SELECT count(*) FROM vocabulary_entries c
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lemma = w.lemma)::int AS saved_count,
           (SELECT coalesce(array_agg(DISTINCT u.display_name ORDER BY u.display_name), '{}'::text[])
              FROM vocabulary_entries c
              JOIN users u ON u.id = c.added_by_user_id
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lemma = w.lemma
               AND c.added_by_user_id <> ${input.ownerUserId}) AS added_by,
           (SELECT count(*) FROM dict_lexemes l
              JOIN dict_glosses g ON g.lexeme_id = l.id
             WHERE l.language_code = ${input.targetLanguage}
               AND l.lemma = w.lemma
               AND g.user_language_code = ${input.sourceLanguage}
               AND g.merged_into IS NULL)::int AS gloss_count
    FROM (VALUES ${sql.join(
      input.lemmas.map((lemma) => sql`(${lemma}::text)`),
      sql`, `,
    )}) AS w(lemma)
    -- Phase 31 (spec D11). The headline is the earliest saved gloss, in its key;
    -- no rendering is read, so a form saved inflected still headlines its
    -- citation form.
    JOIN LATERAL (
      SELECT ve.gloss_id, g.key, v.form
      FROM vocabulary_entries ve
      JOIN dict_glosses g  ON g.id = ve.gloss_id
      JOIN dict_variants v ON v.id = ve.variant_id
      WHERE ve.enrollment_id = ${input.enrollmentId}
        AND ve.lemma = w.lemma
      ORDER BY ve.created_at, ve.gloss_id
      LIMIT 1
    ) h ON true`,

  /** Every lexeme with this lemma in one language, through
   *  dict_lexemes_language_lemma_pos_key. Exact match, case included. */
  lemmaLexemes: (input: { languageCode: string; lemma: string }): SQL => sql`
    SELECT id AS lexeme_id, part_of_speech FROM dict_lexemes
    WHERE language_code = ${input.languageCode}
      AND lemma = ${input.lemma}
    ORDER BY part_of_speech`,

  /** Every rendering of the senses of every lexeme with this lemma, in one user
   *  language, by any form, each with its lexeme and (phase 31) its sense's
   *  gloss in that language, with the gloss's key and alternatives. */
  lemmaRenderings: (input: { languageCode: string; lemma: string; userLanguageCode: string }): SQL => sql`
    SELECT s.lexeme_id, tr.sense_id, m.gloss_id, g.key AS gloss_key, g.alternatives AS gloss_alternatives,
           tr.variant_id, v.form, tr.rank, tr.translation, tr.example_source, tr.example_target
    FROM dict_lexemes l
    JOIN dict_senses s            ON s.lexeme_id = l.id
    JOIN dict_var_translations tr ON tr.sense_id = s.id
                                 AND tr.user_language_code = ${input.userLanguageCode}
    JOIN dict_sense_glosses m     ON m.sense_id = tr.sense_id
                                 AND m.user_language_code = tr.user_language_code
    JOIN dict_glosses g           ON g.id = m.gloss_id
    JOIN dict_variants v          ON v.id = tr.variant_id
    WHERE l.language_code = ${input.languageCode}
      AND l.lemma = ${input.lemma}`,

  /** One lemma's saved glosses in one enrollment, through
   *  vocabulary_entries_enrollment_lemma_idx. */
  savedInLemma: (input: { enrollmentId: string; lemma: string; ownerUserId: string }): SQL => sql`
    SELECT ve.gloss_id, ve.variant_id,
           CASE WHEN ve.added_by_user_id <> ${input.ownerUserId} THEN u.display_name END AS added_by
    FROM vocabulary_entries ve
    JOIN users u ON u.id = ve.added_by_user_id
    WHERE ve.enrollment_id = ${input.enrollmentId}
      AND ve.lemma = ${input.lemma}`,
};

export function createVocabularyRepo(tx: Tx) {
  return {
    findSaveable: async (input: {
      entries: { glossId: string; variantId: string }[];
      targetLanguage: string;
      sourceLanguage: string;
    }): Promise<SaveableEntry[]> => {
      if (input.entries.length === 0) return [];
      const rows = await tx.execute<{ gloss_id: string; variant_id: string; lexeme_id: string; lemma: string }>(
        vocabularyQueries.saveable(input),
      );
      return rows.rows.map((row) => ({
        glossId: row.gloss_id,
        variantId: row.variant_id,
        lexemeId: row.lexeme_id,
        lemma: row.lemma,
      }));
    },

    /** First form wins: a gloss already saved keeps the variant it was saved from. */
    insertEntries: async (input: {
      enrollmentId: string;
      addedByUserId: string;
      entries: SaveableEntry[];
    }): Promise<void> => {
      if (input.entries.length === 0) return;
      await tx.execute(vocabularyQueries.insertEntries(input));
    },

    deleteEntry: async (input: { enrollmentId: string; glossId: string }): Promise<void> => {
      await tx.execute(vocabularyQueries.deleteEntry(input));
    },

    findSavedGlossIds: async (input: { enrollmentId: string; glossIds: string[] }): Promise<string[]> => {
      if (input.glossIds.length === 0) return [];
      const rows = await tx.execute<{ gloss_id: string }>(vocabularyQueries.savedGlossIds(input));
      return rows.rows.map((row) => row.gloss_id);
    },

    /** Every saved gloss of one enrollment, with the sense its saved form ranks
     *  first, for picking a list session. Ordered so a seeded rng picks
     *  reproducibly. Task 11 replaces the sense with a rendering chosen per pick. */
    listSavedGlosses: async (enrollmentId: string): Promise<{ glossId: string; senseId: string; variantId: string }[]> => {
      const rows = await tx.execute<{ gloss_id: string; sense_id: string; variant_id: string }>(sql`
        SELECT DISTINCT ON (ve.gloss_id) ve.gloss_id, tr.sense_id, ve.variant_id
        FROM vocabulary_entries ve
        JOIN dict_sense_glosses m     ON m.gloss_id = ve.gloss_id
        JOIN dict_var_translations tr ON tr.variant_id = ve.variant_id
                                     AND tr.sense_id = m.sense_id
                                     AND tr.user_language_code = m.user_language_code
        WHERE ve.enrollment_id = ${enrollmentId}
        ORDER BY ve.gloss_id, tr.rank`);
      return rows.rows.map((row) => ({ glossId: row.gloss_id, senseId: row.sense_id, variantId: row.variant_id }));
    },

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
      level: number | null;
      live: readonly Dimension[];
    }): Promise<WordPageRow[]> => {
      const rows = await tx.execute<{ lemma: string; last_saved_at: string; level: number }>(
        vocabularyQueries.wordsPage(input),
      );
      return rows.rows.map((row) => ({ lemma: row.lemma, lastSavedAt: row.last_saved_at, level: row.level }));
    },

    findWordSummaries: async (input: {
      enrollmentId: string;
      lemmas: string[];
      targetLanguage: string;
      sourceLanguage: string;
      ownerUserId: string;
    }): Promise<WordSummary[]> => {
      if (input.lemmas.length === 0) return [];
      const rows = await tx.execute<{
        lemma: string;
        parts_of_speech: string[];
        headline_gloss_id: string;
        headline_translation: string;
        headline_form: string;
        saved_count: number;
        gloss_count: number;
        added_by: string[];
      }>(vocabularyQueries.wordSummaries(input));
      return rows.rows.map((row) => ({
        lemma: row.lemma,
        partsOfSpeech: row.parts_of_speech,
        headlineGlossId: row.headline_gloss_id,
        headlineTranslation: row.headline_translation,
        headlineForm: row.headline_form,
        savedCount: row.saved_count,
        glossCount: row.gloss_count,
        addedBy: row.added_by,
      }));
    },

    findLemmaLexemes: async (input: { languageCode: string; lemma: string }): Promise<WordLexeme[]> => {
      const rows = await tx.execute<{ lexeme_id: string; part_of_speech: string }>(
        vocabularyQueries.lemmaLexemes(input),
      );
      return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, partOfSpeech: row.part_of_speech }));
    },

    findLemmaRenderings: async (input: {
      languageCode: string;
      lemma: string;
      userLanguageCode: string;
    }): Promise<LexemeRendering[]> => {
      const rows = await tx.execute<{
        lexeme_id: string;
        sense_id: string;
        gloss_id: string;
        gloss_key: string;
        gloss_alternatives: string[];
        variant_id: string;
        form: string;
        rank: number;
        translation: string;
        example_source: string | null;
        example_target: string | null;
      }>(vocabularyQueries.lemmaRenderings(input));
      return rows.rows.map((row) => ({
        lexemeId: row.lexeme_id,
        senseId: row.sense_id,
        glossId: row.gloss_id,
        glossKey: row.gloss_key,
        glossAlternatives: row.gloss_alternatives,
        variantId: row.variant_id,
        form: row.form,
        rank: row.rank,
        translation: row.translation,
        exampleSource: row.example_source,
        exampleTarget: row.example_target,
      }));
    },

    findSavedInLemma: async (input: {
      enrollmentId: string;
      lemma: string;
      ownerUserId: string;
    }): Promise<SavedEntry[]> => {
      const rows = await tx.execute<{ gloss_id: string; variant_id: string; added_by: string | null }>(
        vocabularyQueries.savedInLemma(input),
      );
      return rows.rows.map((row) => ({ glossId: row.gloss_id, variantId: row.variant_id, addedBy: row.added_by }));
    },
  };
}

export type VocabularyRepo = ReturnType<typeof createVocabularyRepo>;

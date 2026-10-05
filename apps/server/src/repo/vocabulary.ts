import type { VocabularySort } from '@lang-tutor/core/api';
import { DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';
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

// `IN (...)` from a list. `IN ()` is a syntax error, so a caller either guards an
// empty list first (an empty list has an obvious answer that needs no query) or
// passes a list that is never empty (wordsPage's LIVE_DIMENSIONS).
const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

// A word's badge: the rounded mean of its saved senses' live-dimension levels,
// ties up. badge() in packages/core is the same arithmetic in TypeScript.
const LEVEL = sql`floor(avg(p.level) + 0.5)::int`;
const SAVED_AT = sql`max(ve.created_at)`;

function orderBy(sort: VocabularySort): SQL {
  switch (sort) {
    case 'newest':
      return sql`${SAVED_AT} DESC, ve.lexeme_id DESC`;
    case 'level_asc':
      return sql`${LEVEL} ASC, ${SAVED_AT} DESC, ve.lexeme_id DESC`;
    case 'level_desc':
      return sql`${LEVEL} DESC, ${SAVED_AT} DESC, ve.lexeme_id DESC`;
  }
}

/** Strictly after the cursor in the order orderBy gives. level_asc mixes
 *  directions, so it cannot be one row comparison. */
function afterCursor(after: VocabularyCursor): SQL {
  const position = sql`(${after.savedAt}::timestamptz, ${after.lexemeId}::text)`;
  switch (after.sort) {
    case 'newest':
      return sql`(${SAVED_AT}, ve.lexeme_id) < ${position}`;
    case 'level_desc':
      return sql`(${LEVEL}, ${SAVED_AT}, ve.lexeme_id) < (${after.level}::int, ${after.savedAt}::timestamptz, ${after.lexemeId}::text)`;
    case 'level_asc':
      return sql`(${LEVEL} > ${after.level}::int OR (${LEVEL} = ${after.level}::int AND (${SAVED_AT}, ve.lexeme_id) < ${position}))`;
  }
}

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
  /** Save: a primary-key insert, and the five progress rows of every entry it
   *  creates, in one statement. Named conflict target, not bare: only the PK
   *  may be swallowed, so an FK violation still raises. First form wins — a
   *  sense already saved keeps its variant, and RETURNING leaves it out, so its
   *  progress is untouched. */
  insertEntries: (input: { enrollmentId: string; entries: SaveableEntry[] }): SQL => sql`
    WITH inserted AS (
      INSERT INTO vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
      VALUES ${sql.join(
        input.entries.map(
          (e) => sql`(${input.enrollmentId}, ${e.senseId}, ${e.lexemeId}, ${e.variantId})`,
        ),
        sql`, `,
      )}
      ON CONFLICT (enrollment_id, sense_id) DO NOTHING
      RETURNING enrollment_id, sense_id
    )
    INSERT INTO sense_progress (enrollment_id, sense_id, dimension)
    SELECT i.enrollment_id, i.sense_id, d.dimension
    FROM inserted i
    CROSS JOIN (VALUES ${sql.join(
      DIMENSIONS.map((dimension) => sql`(${dimension}::text)`),
      sql`, `,
    )}) AS d(dimension)`,

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
   * One page of lexemes with their level, in the asked order, optionally one
   * level only. The join reads this enrollment's live-dimension progress rows
   * through sense_progress_enrollment_dimension_idx, an index-only scan.
   *
   * The timestamp goes out as `::text` and comes back with `::timestamptz` —
   * microseconds intact; see VocabularyCursor. The comparison is strictly
   * "after the cursor". Under the newest sort a word saved into again only
   * moves to the top, behind the cursor, so it is never served twice in one
   * walk. Under a level sort its key moves both ways mid-walk (a save lowers
   * the mean, a finished session raises it), so a word whose level changes may
   * be served again or passed over.
   */
  wordsPage: (input: {
    enrollmentId: string;
    limit: number;
    after: VocabularyCursor | null;
    sort: VocabularySort;
    level: number | null;
    live: readonly Dimension[];
  }): SQL => {
    const having: SQL[] = [];
    if (input.level !== null) having.push(sql`${LEVEL} = ${input.level}`);
    if (input.after) having.push(afterCursor(input.after));
    // The join below is an inner join: an entry with no live-dimension progress
    // rows drops out of the list, while the detail reads the same entry as level 1
    // (senseProgressOf's fallback). Acceptable because it cannot happen today: the
    // only writer of entries (insertEntries) creates their rows in the same
    // statement, and the migration backfilled the older ones.
    return sql`
      SELECT ve.lexeme_id, ${SAVED_AT}::text AS last_saved_at, ${LEVEL} AS level
      FROM vocabulary_entries ve
      JOIN sense_progress p ON p.enrollment_id = ve.enrollment_id
                           AND p.sense_id = ve.sense_id
                           AND p.dimension IN (${inList([...input.live])})
      WHERE ve.enrollment_id = ${input.enrollmentId}
      GROUP BY ve.lexeme_id
      ${having.length > 0 ? sql`HAVING ${sql.join(having, sql` AND `)}` : sql``}
      ORDER BY ${orderBy(input.sort)}
      LIMIT ${input.limit}`;
  },

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
      sort: VocabularySort;
      level: number | null;
      live: readonly Dimension[];
    }): Promise<WordPageRow[]> => {
      const rows = await tx.execute<{ lexeme_id: string; last_saved_at: string; level: number }>(
        vocabularyQueries.wordsPage(input),
      );
      return rows.rows.map((row) => ({
        lexemeId: row.lexeme_id,
        lastSavedAt: row.last_saved_at,
        level: row.level,
      }));
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

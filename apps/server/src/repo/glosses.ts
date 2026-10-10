import { eq, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { dictGlosses } from '../db/schema';
import { keptEntry, mergeLevels, mergeSnapshots, tidyGlossList } from '../domain/glosses';

/** A gloss id as a write uses it: its survivor's, after any merge. */
export type ResolvedGloss = { id: string; lexemeId: string; userLanguageCode: string };

/** What one merge re-keyed, for the `gloss_merged` log (spec D19). */
export type MergeCounts = {
  entriesMoved: number;
  entriesFolded: number;
  snapshots: number;
  questions: number;
  memberships: number;
};

/** One lexeme and learner language the tool looks at: two or more live glosses,
 *  or a sense with no definition. */
export type MergeWork = {
  lexemeId: string;
  lemma: string;
  partOfSpeech: string;
  languageCode: string;
  userLanguageCode: string;
  glosses: { id: string; key: string; alternatives: string[] }[];
  senses: { senseId: string; senseCode: string; gloss: string; definition: string | null }[];
};

const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);
// A save time as fixed-width UTC text, so keptEntry can compare it as text.
const savedAt = (alias: 's' | 'o') =>
  sql.raw(`to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`);

/**
 * Phase 31 (spec D7, D14). Glosses as a learner's unit: resolving an id through
 * a merge, and the merge itself, which is the only regroup and runs outside the
 * lookup. A merge spans the dictionary and every learner table keyed on a gloss,
 * which is why it has a repository of its own.
 *
 * Locking. A merge runs under its lexeme's FOR UPDATE lock (lockLexemes, taken by
 * the caller). Every learner write takes FOR SHARE on the same row through
 * resolveGlosses (or ProgressRepo.lockSessionGlosses) before it reads an id, so
 * a write and a merge of one lexeme run one after the other, never interleaved.
 * A gloss never changes lexeme, so the row to lock is known before the lock.
 */
export function createGlossRepo(tx: Tx) {
  const resolveGlosses = async (ids: string[]): Promise<Map<string, ResolvedGloss>> => {
    const asked = [...new Set(ids)];
    if (asked.length === 0) return new Map();
    await tx.execute(sql`
      SELECT l.id FROM dict_lexemes l
      WHERE l.id IN (SELECT g.lexeme_id FROM dict_glosses g WHERE g.id IN (${inList(asked)}))
      ORDER BY l.id
      FOR SHARE`);
    // One hop: a merge re-points every gloss forwarded to the one it forwards,
    // so no chain forms.
    const rows = await tx.execute<{ asked: string; id: string; lexeme_id: string; user_language_code: string }>(sql`
      SELECT g.id AS asked, s.id, s.lexeme_id, s.user_language_code
      FROM dict_glosses g
      JOIN dict_glosses s ON s.id = coalesce(g.merged_into, g.id)
      WHERE g.id IN (${inList(asked)})`);
    return new Map(
      rows.rows.map((row) => [row.asked, { id: row.id, lexemeId: row.lexeme_id, userLanguageCode: row.user_language_code }]),
    );
  };

  /**
   * Spec D7's automatic signal (decided while planning, item 4): a blocked
   * rename. It reads what decides a rename in the write (domain/glosses.ts,
   * assignGlosses): for each live gloss, its first member's lemma-form rendering
   * alone, the one ranked lowest on the lemma form (a tie, which only two
   * lemma-form variants of one lexeme can make, by sense id, then variant). The gloss
   * is a candidate when that rendering's citation form is not its key and is
   * another live gloss's key. That other gloss survives: its key is the lemma
   * form's (D6).
   *
   * A later member's other word is never a signal: the write never renames on
   * it (D6's `difficult`, whose second sense is קשה one day and מסובך another),
   * and a merge cannot be undone.
   */
  const findMergeCandidates = async (input: {
    lexemeId: string;
    userLanguageCode: string;
  }): Promise<{ otherId: string; survivorId: string }[]> => {
    const rows = await tx.execute<{ other_id: string; survivor_id: string }>(sql`
      WITH firsts AS (
        SELECT DISTINCT ON (g.id) g.id, g.key, tr.gloss
        FROM dict_glosses g
        JOIN dict_lexemes l           ON l.id = g.lexeme_id
        JOIN dict_sense_glosses m     ON m.gloss_id = g.id
        JOIN dict_var_translations tr ON tr.sense_id = m.sense_id
                                     AND tr.user_language_code = m.user_language_code
        JOIN dict_variants v          ON v.id = tr.variant_id
                                     AND v.lexeme_id = g.lexeme_id
                                     AND lower(v.form) = lower(l.lemma)
        WHERE g.lexeme_id = ${input.lexemeId}
          AND g.user_language_code = ${input.userLanguageCode}
          AND g.merged_into IS NULL
        ORDER BY g.id, tr.rank, tr.sense_id, tr.variant_id
      )
      SELECT f.id AS other_id, s.id AS survivor_id
      FROM firsts f
      JOIN dict_glosses s ON s.lexeme_id = ${input.lexemeId}
                         AND s.user_language_code = ${input.userLanguageCode}
                         AND s.merged_into IS NULL
                         AND gloss_key(s.key) = gloss_key(f.gloss)
      WHERE gloss_key(f.gloss) <> gloss_key(f.key)
      ORDER BY f.id`);
    return rows.rows.map((row) => ({ otherId: row.other_id, survivorId: row.survivor_id }));
  };

  /**
   * Spec D7. Folds `other` into `survivor`, both live glosses of one lexeme and
   * language: entries (an enrollment holding both keeps one, the earlier save,
   * at each dimension's best), session snapshots, questions and memberships move
   * to the survivor; the survivor takes the other's key and alternatives as its
   * own alternatives; the other forwards to it, and so does anything that
   * forwarded to the other. Photo rows are left alone: their options are a
   * snapshot, and a stale id resolves when the import is saved.
   *
   * Null when there is nothing to do (either gloss gone or no longer live, or
   * one gloss asked to merge into itself, which a plan built from the model's
   * groups can name), which is what makes a retried job safe. The caller holds
   * lockLexemes.
   */
  const mergeGlosses = async (input: { survivorId: string; otherId: string }): Promise<MergeCounts | null> => {
    if (input.survivorId === input.otherId) return null;
    const glosses = await tx.execute<{
      id: string;
      lexeme_id: string;
      user_language_code: string;
      key: string;
      alternatives: string[];
      merged_into: string | null;
    }>(sql`
      SELECT id, lexeme_id, user_language_code, key, alternatives, merged_into
      FROM dict_glosses WHERE id IN (${input.survivorId}, ${input.otherId})`);
    const survivor = glosses.rows.find((row) => row.id === input.survivorId);
    const other = glosses.rows.find((row) => row.id === input.otherId);
    if (!survivor || !other || survivor.merged_into !== null || other.merged_into !== null) return null;
    if (survivor.lexeme_id !== other.lexeme_id || survivor.user_language_code !== other.user_language_code) {
      throw new Error(`glosses ${input.otherId} and ${input.survivorId} are not of one lexeme and language`);
    }

    // 1. Enrollments holding both: fold the progress onto the survivor's rows,
    //    keep the earlier save, drop the other entry (its progress cascades).
    const both = await tx.execute<{
      enrollment_id: string;
      s_variant: string;
      s_adder: string;
      s_saved: string;
      o_variant: string;
      o_adder: string;
      o_saved: string;
    }>(sql`
      SELECT o.enrollment_id,
             s.variant_id AS s_variant, s.added_by_user_id AS s_adder, ${savedAt('s')} AS s_saved,
             o.variant_id AS o_variant, o.added_by_user_id AS o_adder, ${savedAt('o')} AS o_saved
      FROM vocabulary_entries o
      JOIN vocabulary_entries s ON s.enrollment_id = o.enrollment_id AND s.gloss_id = ${input.survivorId}
      WHERE o.gloss_id = ${input.otherId}`);
    for (const row of both.rows) {
      const levels = await tx.execute<{
        dimension: string;
        s_level: number;
        s_step: string | null;
        s_wrong: string | null;
        o_level: number;
        o_step: string | null;
        o_wrong: string | null;
      }>(sql`
        SELECT o.dimension,
               s.level AS s_level, s.last_step_on::text AS s_step, s.last_wrong_on::text AS s_wrong,
               o.level AS o_level, o.last_step_on::text AS o_step, o.last_wrong_on::text AS o_wrong
        FROM gloss_progress o
        JOIN gloss_progress s ON s.enrollment_id = o.enrollment_id AND s.dimension = o.dimension
                             AND s.gloss_id = ${input.survivorId}
        WHERE o.enrollment_id = ${row.enrollment_id} AND o.gloss_id = ${input.otherId}`);
      for (const level of levels.rows) {
        const folded = mergeLevels(
          { level: level.s_level, lastStepOn: level.s_step, lastWrongOn: level.s_wrong },
          { level: level.o_level, lastStepOn: level.o_step, lastWrongOn: level.o_wrong },
        );
        await tx.execute(sql`
          UPDATE gloss_progress
          SET level = ${folded.level}, last_step_on = ${folded.lastStepOn}::date, last_wrong_on = ${folded.lastWrongOn}::date
          WHERE enrollment_id = ${row.enrollment_id} AND gloss_id = ${input.survivorId} AND dimension = ${level.dimension}`);
      }
      const kept = keptEntry(
        { variantId: row.s_variant, addedByUserId: row.s_adder, savedAt: row.s_saved },
        { variantId: row.o_variant, addedByUserId: row.o_adder, savedAt: row.o_saved },
      );
      if (kept.savedAt === row.o_saved && row.o_saved !== row.s_saved) {
        await tx.execute(sql`
          UPDATE vocabulary_entries s
          SET variant_id = o.variant_id, added_by_user_id = o.added_by_user_id, created_at = o.created_at
          FROM vocabulary_entries o
          WHERE s.enrollment_id = ${row.enrollment_id} AND s.gloss_id = ${input.survivorId}
            AND o.enrollment_id = s.enrollment_id AND o.gloss_id = ${input.otherId}`);
      }
      await tx.execute(sql`DELETE FROM vocabulary_entries WHERE enrollment_id = ${row.enrollment_id} AND gloss_id = ${input.otherId}`);
    }

    // 2. Enrollments holding only the other: the entry moves, and its progress
    //    rows follow it (gloss_progress_entry_fk is ON UPDATE CASCADE).
    const moved = await tx.execute(sql`UPDATE vocabulary_entries SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);

    // 3. Snapshots: a session that practised both folds (mergeSnapshots); the rest move.
    const sessions = await tx.execute<{ session_id: string; dimension: string; s_before: number; s_after: number; o_before: number; o_after: number }>(sql`
      SELECT o.session_id, o.dimension, s.level_before AS s_before, s.level_after AS s_after,
             o.level_before AS o_before, o.level_after AS o_after
      FROM session_progress o
      JOIN session_progress s ON s.session_id = o.session_id AND s.dimension = o.dimension AND s.gloss_id = ${input.survivorId}
      WHERE o.gloss_id = ${input.otherId}`);
    for (const row of sessions.rows) {
      const folded = mergeSnapshots({ levelBefore: row.s_before, levelAfter: row.s_after }, { levelBefore: row.o_before, levelAfter: row.o_after });
      await tx.execute(sql`
        UPDATE session_progress SET level_before = ${folded.levelBefore}, level_after = ${folded.levelAfter}
        WHERE session_id = ${row.session_id} AND gloss_id = ${input.survivorId} AND dimension = ${row.dimension}`);
      await tx.execute(sql`
        DELETE FROM session_progress
        WHERE session_id = ${row.session_id} AND gloss_id = ${input.otherId} AND dimension = ${row.dimension}`);
    }
    const snapshots = await tx.execute(sql`UPDATE session_progress SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);

    // 4. Questions and memberships.
    const questions = await tx.execute(sql`UPDATE questions SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);
    const memberships = await tx.execute(sql`UPDATE dict_sense_glosses SET gloss_id = ${input.survivorId} WHERE gloss_id = ${input.otherId}`);

    // 5. The other's words become the survivor's alternatives. Through the query
    //    builder: an array inside a sql`` template expands into a list.
    const alternatives = tidyGlossList([...survivor.alternatives, other.key, ...other.alternatives], survivor.key);
    await tx.update(dictGlosses).set({ alternatives }).where(eq(dictGlosses.id, input.survivorId));

    // 6. Forward the other, and whatever forwarded to it.
    await tx.execute(sql`
      UPDATE dict_glosses SET merged_into = ${input.survivorId}
      WHERE id = ${input.otherId} OR merged_into = ${input.otherId}`);

    return {
      entriesMoved: moved.rowCount ?? 0,
      entriesFolded: both.rows.length,
      snapshots: (snapshots.rowCount ?? 0) + sessions.rows.length,
      questions: questions.rowCount ?? 0,
      memberships: memberships.rowCount ?? 0,
    };
  };

  /** Phase 31 (spec D7, the tool). The whole dictionary's work list. A by-hand
   *  tool reads everything once; nothing on a learner's path calls this. */
  const findMergeWork = async (): Promise<MergeWork[]> => {
    const glosses = await tx.execute<{
      id: string; lexeme_id: string; lemma: string; part_of_speech: string;
      language_code: string; user_language_code: string; key: string; alternatives: string[];
    }>(sql`
      SELECT g.id, g.lexeme_id, l.lemma, l.part_of_speech, l.language_code, g.user_language_code, g.key, g.alternatives
      FROM dict_glosses g JOIN dict_lexemes l ON l.id = g.lexeme_id
      WHERE g.merged_into IS NULL
      ORDER BY l.lemma, g.user_language_code, g.key`);
    const senses = await tx.execute<{
      sense_id: string; sense_code: string; definition: string | null; lexeme_id: string; user_language_code: string; key: string;
    }>(sql`
      SELECT s.id AS sense_id, s.sense_code, s.definition, m.lexeme_id, m.user_language_code, g.key
      FROM dict_sense_glosses m
      JOIN dict_senses s  ON s.id = m.sense_id
      JOIN dict_glosses g ON g.id = m.gloss_id
      ORDER BY s.sense_code`);
    const work = new Map<string, MergeWork>();
    for (const row of glosses.rows) {
      const id = `${row.lexeme_id} ${row.user_language_code}`;
      const item = work.get(id) ?? {
        lexemeId: row.lexeme_id,
        lemma: row.lemma,
        partOfSpeech: row.part_of_speech,
        languageCode: row.language_code,
        userLanguageCode: row.user_language_code,
        glosses: [],
        senses: [],
      };
      item.glosses.push({ id: row.id, key: row.key, alternatives: row.alternatives });
      work.set(id, item);
    }
    for (const row of senses.rows) {
      work.get(`${row.lexeme_id} ${row.user_language_code}`)?.senses.push({
        senseId: row.sense_id,
        senseCode: row.sense_code,
        gloss: row.key,
        definition: row.definition,
      });
    }
    return [...work.values()].filter((item) => item.glosses.length >= 2 || item.senses.some((sense) => sense.definition === null));
  };

  /** Phase 31 (spec D9). Fills definitions a sense lacks; one already there stays. */
  const setDefinitions = async (rows: { senseId: string; definition: string }[]): Promise<number> => {
    let filled = 0;
    for (const row of rows) {
      const result = await tx.execute(sql`UPDATE dict_senses SET definition = ${row.definition} WHERE id = ${row.senseId} AND definition IS NULL`);
      filled += result.rowCount ?? 0;
    }
    return filled;
  };

  return { resolveGlosses, findMergeCandidates, mergeGlosses, findMergeWork, setDefinitions };
}

export type GlossRepo = ReturnType<typeof createGlossRepo>;

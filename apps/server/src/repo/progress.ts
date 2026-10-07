import type { AnswerVerdict } from '@lang-tutor/core/api';
import type { Dimension } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { sessionProgress, type QuestionOption } from '../db/schema';
import type {
  AnsweredQuestion,
  ChoiceAnswerType,
  ProgressRow,
  SnapshotRead,
  SnapshotRow,
  TextAnswerType,
} from '../domain/progress';
import { canonicalOptions } from './questions';

const TEXT_TYPES: ReadonlySet<string> = new Set([
  'typed_translation',
  'dictation',
  'letter_tiles',
  'read_aloud',
  'say_translation',
  'typed_meaning',
  'cloze_typed',
  'sentence_translation',
]);

/** A session's answers as the rule reads them. */
export type SessionEvidence = {
  enrollmentId: string;
  /** The UTC date of the session's last answer: the day the session counts for. */
  day: string;
  /** The last answer's time as Postgres prints it. The recompute compares it with
   *  each entry's save time, and the `::text` round trip keeps microseconds. */
  lastAnsweredAt: string;
  answers: AnsweredQuestion[];
};

// `IN (...)` from a list. `IN ()` is a syntax error: the caller guards an empty
// list first (findRows does) or passes a list that is never empty.
const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * Phase 20. sense_progress and session_progress. Every statement is scoped to
 * one session or to one enrollment's handful of senses, on a primary key; the
 * list's level aggregate lives in repo/vocabulary.ts.
 *
 * No row locks: an enrollment's progress is written only when one of its
 * sessions ends, its sessions end one at a time (the session row is locked by
 * loadSession and findState, and at most one is open), and the recompute holds
 * a table lock on sessions (lockSessions) so no session ends while it runs.
 */
export function createProgressRepo(tx: Tx) {
  return {
    findSessionEvidence: async (sessionId: string): Promise<SessionEvidence | undefined> => {
      const rows = await tx.execute<{
        enrollment_id: string;
        sense_id: string;
        type: string;
        options: QuestionOption[] | null;
        selected_option_position: number | null;
        verdict: string | null;
        day: string;
        last_answered_at: string;
      }>(sql`
        SELECT s.enrollment_id, q.sense_id, q.type, q.options, a.selected_option_position, a.verdict,
               ((max(a.answered_at) OVER ()) AT TIME ZONE 'UTC')::date::text AS day,
               (max(a.answered_at) OVER ())::text AS last_answered_at
        FROM answers a
        JOIN sessions s  ON s.id = a.session_id
        JOIN questions q ON q.id = a.question_id
        WHERE a.session_id = ${sessionId}
        ORDER BY a.position`);
      if (rows.rows.length === 0) return undefined;
      const first = rows.rows[0];
      return {
        enrollmentId: first.enrollment_id,
        day: first.day,
        lastAnsweredAt: first.last_answered_at,
        answers: rows.rows.map((row): AnsweredQuestion => {
          // Phase 23 and 24. A text answer carries the verdict it was shown.
          if (TEXT_TYPES.has(row.type)) {
            return { senseId: row.sense_id, type: row.type as TextAnswerType, verdict: row.verdict as AnswerVerdict };
          }
          return {
            senseId: row.sense_id,
            type: row.type as ChoiceAnswerType,
            // selected_option_position is canonical (sessions.insertAnswer), and
            // question_options_valid makes positions 0..n-1.
            correct: canonicalOptions(row.options!)[row.selected_option_position!].is_correct,
          };
        }),
      };
    },

    /** The rows of the asked senses that are saved. `savedBy` leaves out a sense
     *  saved after that time: the recompute's "saved by the session's last
     *  answer". The live path passes null. */
    findRows: async (input: {
      enrollmentId: string;
      senseIds: string[];
      savedBy: string | null;
    }): Promise<ProgressRow[]> => {
      if (input.senseIds.length === 0) return [];
      const rows = await tx.execute<{
        sense_id: string;
        dimension: string;
        level: number;
        last_step_on: string | null;
        last_wrong_on: string | null;
      }>(sql`
        SELECT p.sense_id, p.dimension, p.level,
               p.last_step_on::text AS last_step_on, p.last_wrong_on::text AS last_wrong_on
        FROM sense_progress p
        JOIN vocabulary_entries ve ON ve.enrollment_id = p.enrollment_id
                                  AND ve.sense_id = p.sense_id
        WHERE p.enrollment_id = ${input.enrollmentId}
          AND p.sense_id IN (${inList(input.senseIds)})
          ${input.savedBy === null ? sql`` : sql`AND ve.created_at <= ${input.savedBy}::timestamptz`}
        ORDER BY p.sense_id, p.dimension`);
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        dimension: row.dimension as Dimension,
        level: row.level,
        lastStepOn: row.last_step_on,
        lastWrongOn: row.last_wrong_on,
      }));
    },

    updateRows: async (input: { enrollmentId: string; rows: ProgressRow[] }): Promise<void> => {
      if (input.rows.length === 0) return;
      await tx.execute(sql`
        UPDATE sense_progress p
        SET level = v.level,
            last_step_on = v.last_step_on::date,
            last_wrong_on = v.last_wrong_on::date
        FROM (VALUES ${sql.join(
          input.rows.map(
            (row) =>
              sql`(${row.senseId}::text, ${row.dimension}::text, ${row.level}::int, ${row.lastStepOn}::text, ${row.lastWrongOn}::text)`,
          ),
          sql`, `,
        )}) AS v(sense_id, dimension, level, last_step_on, last_wrong_on)
        WHERE p.enrollment_id = ${input.enrollmentId}
          AND p.sense_id = v.sense_id
          AND p.dimension = v.dimension`);
    },

    insertSnapshot: async (input: { sessionId: string; rows: SnapshotRow[] }): Promise<void> => {
      if (input.rows.length === 0) return;
      await tx.insert(sessionProgress).values(
        input.rows.map((row) => ({
          sessionId: input.sessionId,
          senseId: row.senseId,
          dimension: row.dimension,
          levelBefore: row.levelBefore,
          levelAfter: row.levelAfter,
        })),
      );
    },

    /** The snapshot with the form and the meaning of the first question in the
     *  session that asked each sense. Phase 23: a reversed or typed card asked
     *  the meaning, which it stores as its prompt; today's card offers it as
     *  its right option. Either way the results show form → meaning. */
    findSnapshot: async (sessionId: string): Promise<SnapshotRead[]> => {
      const rows = await tx.execute<{
        sense_id: string;
        dimension: string;
        level_before: number;
        level_after: number;
        form: string;
        prompt: string | null;
        options: QuestionOption[] | null;
        position: number;
      }>(sql`
        SELECT sp.sense_id, sp.dimension, sp.level_before, sp.level_after, f.form, f.prompt, f.options, f.position
        FROM session_progress sp
        JOIN LATERAL (
          SELECT v.form, q.prompt, q.options, sq.position
          FROM session_questions sq
          JOIN questions q     ON q.id = sq.question_id
          JOIN dict_variants v ON v.id = q.prompt_variant_id
          WHERE sq.session_id = sp.session_id
            AND q.sense_id = sp.sense_id
          ORDER BY sq.position
          LIMIT 1
        ) f ON true
        WHERE sp.session_id = ${sessionId}`);
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        dimension: row.dimension as Dimension,
        levelBefore: row.level_before,
        levelAfter: row.level_after,
        form: row.form,
        translation: row.prompt ?? canonicalOptions(row.options!).find((option) => option.is_correct)!.text,
        position: row.position,
      }));
    },

    /** Recompute only: SHARE mode on sessions, held to the end of the transaction.
     *  It conflicts with the ROW EXCLUSIVE lock a session status UPDATE takes, so
     *  no session ends while it is held; reads and FOR UPDATE row locks pass. */
    lockSessions: async (): Promise<void> => {
      await tx.execute(sql`LOCK TABLE sessions IN SHARE MODE`);
    },

    /** Recompute only: every row back to level 1, and no session's snapshot. */
    resetAll: async (): Promise<void> => {
      await tx.execute(sql`UPDATE sense_progress SET level = 1, last_step_on = NULL, last_wrong_on = NULL`);
      await tx.execute(sql`DELETE FROM session_progress`);
    },

    /** Recompute only: every completed or skipped session that has answers, in
     *  the order of its last answer. An enrollment's sessions run one at a time,
     *  so this is the order they ended in. */
    listEndedSessions: async (): Promise<string[]> => {
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT s.id
        FROM sessions s
        JOIN answers a ON a.session_id = s.id
        WHERE s.status IN ('completed', 'skipped')
        GROUP BY s.id
        ORDER BY max(a.answered_at), s.id`);
      return rows.rows.map((row) => row.id);
    },
  };
}

export type ProgressRepo = ReturnType<typeof createProgressRepo>;

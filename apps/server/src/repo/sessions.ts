import type { AnswerRecord, Question, SessionSource, SessionStatus, TypedVerdict } from '@lang-tutor/core/api';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type { SessionRecord, SessionState, SessionSummary } from '../domain/session';
import {
  answers,
  dictLexemes,
  dictVariants,
  questions,
  sessionQuestions,
  sessions,
  type QuestionOption,
} from '../db/schema';
import { SessionOpen } from '../errors';
import { isUniqueViolation } from './pgErrors';
import { canonicalOptions, questionColumns, questionFrom, withBoards } from './questions';

// `sessions.id` is a `uuid` column: a malformed value makes Postgres raise
// 22P02 (invalid input syntax for type uuid) before a WHERE clause can even
// run, which would otherwise surface as an uncaught 500 rather than the
// "not found" a bad id actually means. Reject the shape first so a malformed
// id is indistinguishable from an id that is merely absent.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSessionRepo(tx: Tx) {
  // The one-open-session index (sessions_one_open_per_enrollment) is the only
  // unique constraint on this table, so a unique violation here means exactly
  // "this enrollment already has an open session".
  async function insertSessionRow(values: {
    userId: string;
    enrollmentId: string;
    status: SessionStatus;
    source: SessionSource;
  }): Promise<string> {
    try {
      const [row] = await tx.insert(sessions).values(values).returning({ id: sessions.id });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new SessionOpen(values.enrollmentId);
      throw error;
    }
  }

  /**
   * `picked` has its options already shuffled (`shuffleSession`). Each option's
   * text is mapped back to its canonical position to build `option_order` —
   * unambiguous because `question_options_valid` guarantees distinct texts
   * within a question. A text card (typed, dictation, tiles) has no options, so its order is `{}`.
   */
  async function insertSessionQuestions(sessionId: string, picked: Question[]): Promise<void> {
    const rows = await tx
      .select({ id: questions.id, options: questions.options })
      .from(questions)
      .where(
        inArray(
          questions.id,
          picked.map((question) => question.id),
        ),
      );
    const canonicalById = new Map<string, QuestionOption[]>(
      rows.flatMap((row) => (row.options ? [[row.id, canonicalOptions(row.options)] as const] : [])),
    );

    await tx.insert(sessionQuestions).values(
      picked.map((question, position) => {
        if (!('options' in question)) {
          return { sessionId, position, questionId: question.id, optionOrder: [] };
        }
        const canonical = canonicalById.get(question.id);
        if (!canonical) throw new Error(`question ${question.id} is not in the database`);
        return {
          sessionId,
          position,
          questionId: question.id,
          optionOrder: question.options.map((text) => {
            const index = canonical.findIndex((option) => option.text === text);
            if (index < 0) throw new Error(`option "${text}" is not on question ${question.id}`);
            return index;
          }),
        };
      }),
    );
  }

  return {
    /** A seed session: ready at once, its questions drawn from the shared pool. */
    insertSession: async (
      userId: string,
      enrollmentId: string,
      picked: Question[],
    ): Promise<string> => {
      const sessionId = await insertSessionRow({ userId, enrollmentId, status: 'ready', source: 'seed' });
      await insertSessionQuestions(sessionId, picked);
      return sessionId;
    },

    /** A list session: no questions until prepare-session writes them. */
    insertPreparingSession: (userId: string, enrollmentId: string): Promise<string> =>
      insertSessionRow({ userId, enrollmentId, status: 'preparing', source: 'list' }),

    insertSessionQuestions,

    /** Phase 24 (spec D3). How many list sessions an enrollment has had, of any
     *  status: the planner's rotation step for the next one. */
    countListSessions: async (enrollmentId: string): Promise<number> => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(and(eq(sessions.enrollmentId, enrollmentId), eq(sessions.source, 'list')));
      return row.count;
    },

    /** Locks the row, so a status read here and changed later in the same
     *  transaction cannot race a concurrent skip or job. */
    findState: async (sessionId: string): Promise<SessionState | undefined> => {
      if (!UUID_RE.test(sessionId)) return undefined;
      const [row] = await tx
        .select({
          id: sessions.id,
          userId: sessions.userId,
          enrollmentId: sessions.enrollmentId,
          status: sessions.status,
          source: sessions.source,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for('update');
      return row
        ? { ...row, status: row.status as SessionStatus, source: row.source as SessionSource }
        : undefined;
    },

    /** A conditional status change: true when the row was in one of `from`.
     *  Conditional so a job finishing after a skip changes nothing. */
    transition: async (
      sessionId: string,
      from: SessionStatus[],
      to: SessionStatus,
    ): Promise<boolean> => {
      if (!UUID_RE.test(sessionId)) return false;
      const rows = await tx
        .update(sessions)
        .set({ status: to })
        .where(and(eq(sessions.id, sessionId), inArray(sessions.status, from)))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    /** The enrollment's newest session. At most one session is open, and a new
     *  one can only start once it is closed, so an open session is always the
     *  newest: this one read answers both "what is current" and "has there been
     *  any". Served by sessions_enrollment_created_idx. */
    findLatest: async (enrollmentId: string): Promise<SessionSummary | undefined> => {
      const rows = await tx.execute<{
        id: string;
        status: string;
        source: string;
        answered: number;
        total: number;
      }>(sql`
        SELECT s.id, s.status, s.source,
               (SELECT count(*) FROM answers a WHERE a.session_id = s.id)::int AS answered,
               (SELECT count(*) FROM session_questions q WHERE q.session_id = s.id)::int AS total
        FROM sessions s
        WHERE s.enrollment_id = ${enrollmentId}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1`);
      const row = rows.rows[0];
      return row
        ? { ...row, status: row.status as SessionStatus, source: row.source as SessionSource }
        : undefined;
    },

    /**
     * Three queries, deliberately explicit rather than a Drizzle relational
     * `with:` (which would need a `relations()` declaration per table). The
     * `FOR UPDATE` on the session row serialises concurrent next-step requests.
     */
    loadSession: async (sessionId: string): Promise<SessionRecord | undefined> => {
      if (!UUID_RE.test(sessionId)) return undefined;

      const [session] = await tx
        .select({
          id: sessions.id,
          userId: sessions.userId,
          completedAt: sessions.completedAt,
          status: sessions.status,
          source: sessions.source,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for('update');
      if (!session) return undefined;

      const questionRows = await tx
        .select({ ...questionColumns, optionOrder: sessionQuestions.optionOrder })
        .from(sessionQuestions)
        .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
        .innerJoin(dictVariants, eq(dictVariants.id, questions.promptVariantId))
        .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
        .where(eq(sessionQuestions.sessionId, sessionId))
        .orderBy(asc(sessionQuestions.position));

      const answerRows = await tx
        .select({
          position: answers.position,
          questionId: answers.questionId,
          selectedOptionPosition: answers.selectedOptionPosition,
          typedText: answers.typedText,
          verdict: answers.verdict,
        })
        .from(answers)
        .where(eq(answers.sessionId, sessionId))
        .orderBy(asc(answers.position));

      // answers_kind_valid: an answer is an option or a text with its verdict.
      const answerRecords: AnswerRecord[] = answerRows.map((answer) => {
        if (answer.typedText !== null) {
          const verdict = answer.verdict as TypedVerdict;
          return {
            question_id: answer.questionId,
            is_correct: verdict !== 'wrong',
            answer_string: answer.typedText,
            verdict,
          };
        }
        const chosen = canonicalOptions(questionRows[answer.position].options!)[answer.selectedOptionPosition!];
        return {
          question_id: answer.questionId,
          is_correct: chosen.is_correct,
          answer_string: chosen.text,
        };
      });

      return {
        user_id: session.userId,
        questions: withBoards(questionRows.map((row) => questionFrom(row, row.optionOrder))),
        answers: answerRecords,
        complete: session.completedAt !== null,
        completed_at: session.completedAt === null ? null : session.completedAt.getTime(),
        status: session.status as SessionStatus,
        source: session.source as SessionSource,
      };
    },

    /**
     * A choice's `displayIndex` is the index the learner saw. Translating it to
     * the option's authored position is this module's own business —
     * `option_order` is the encoding `insertSession` wrote, so nothing above
     * needs to know it exists. The extra lookup is one primary-key read inside
     * a transaction that is already holding this session's row. A typed answer
     * (phase 23) is stored as its text and the verdict the learner was shown.
     */
    insertAnswer: async (
      sessionId: string,
      position: number,
      questionId: string,
      answer: { displayIndex: number } | { text: string; verdict: TypedVerdict },
    ): Promise<void> => {
      if ('text' in answer) {
        await tx.insert(answers).values({
          sessionId,
          position,
          questionId,
          typedText: answer.text,
          verdict: answer.verdict,
        });
        return;
      }

      const [row] = await tx
        .select({ optionOrder: sessionQuestions.optionOrder })
        .from(sessionQuestions)
        .where(
          and(eq(sessionQuestions.sessionId, sessionId), eq(sessionQuestions.position, position)),
        );
      if (!row) throw new Error(`session ${sessionId} has no question at position ${position}`);

      await tx.insert(answers).values({
        sessionId,
        position,
        questionId,
        selectedOptionPosition: row.optionOrder[answer.displayIndex],
      });
    },

    completeSession: (sessionId: string): Promise<unknown> =>
      tx
        .update(sessions)
        .set({ completedAt: sql`now()`, status: 'completed' })
        .where(eq(sessions.id, sessionId)),
  };
}

export type SessionRepo = ReturnType<typeof createSessionRepo>;

// The injected factory's type. Typing only this would leave the hole open: since
// `Tx` is assignable to `Db`, a `Db`-taking factory still satisfies it by
// parameter contravariance — so `createSessionRepo` itself must take a `Tx`.
export type CreateSessionRepo = (tx: Tx) => SessionRepo;

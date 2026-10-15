import type { AnswerRecord, AnswerVerdict, Question, SessionSource, SessionStatus } from '@lang-tutor/core/api';
import { verdictCorrect } from '@lang-tutor/core/domain';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type { Devices, SessionRecord, SessionState, SessionSummary } from '../domain/session';
import type { DayAnswer } from '../domain/today';
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
import { decodeAnswer, type AnswerRow } from './progress';
import { canonicalOptions, questionColumns, questionFrom, withBoards } from './questions';

// `sessions.id` is a `uuid` column: a malformed value makes Postgres raise
// 22P02 (invalid input syntax for type uuid) before a WHERE clause can even
// run, which would otherwise surface as an uncaught 500 rather than the
// "not found" a bad id actually means. Reject the shape first so a malformed
// id is indistinguishable from an id that is merely absent.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSessionRepo(tx: Tx) {
  // The two open-session indexes (phase 43: one in stock, one started) are the
  // only unique constraints on this table, so a unique violation here means
  // exactly "this enrollment already has an open session of that kind".
  async function insertSessionRow(values: {
    userId: string;
    enrollmentId: string;
    status: SessionStatus;
    source: SessionSource;
    listening: boolean;
    speaking: boolean;
    chosenOn?: string;
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
    /** A seed session: ready at once, its questions drawn from the shared pool.
     *  Phase 43 (spec D1): every session records what it was built for. */
    insertSession: async (
      userId: string,
      enrollmentId: string,
      picked: Question[],
      devices: Devices,
    ): Promise<string> => {
      const sessionId = await insertSessionRow({ userId, enrollmentId, status: 'ready', source: 'seed', ...devices });
      await insertSessionQuestions(sessionId, picked);
      return sessionId;
    },

    /** A list session: no questions until prepare-session writes them. Phase 53 (spec
     *  D12): `chosenOn` is the learner day its words were chosen. */
    insertPreparingSession: (userId: string, enrollmentId: string, devices: Devices, chosenOn: string): Promise<string> =>
      insertSessionRow({ userId, enrollmentId, status: 'preparing', source: 'list', chosenOn, ...devices }),

    /** Phase 43 (review C1). Serializes, per enrollment, the use cases that make
     *  its next session, create and the stock job: the second waits for the
     *  first to commit, then reads what it made rather than racing it into the
     *  index. Held to the end of the transaction. */
    lockNextSession: async (enrollmentId: string): Promise<void> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`next-session:${enrollmentId}`}, 0))`);
    },

    /** Phase 43 (spec D2). Starts a ready session: true when this call started
     *  it, false when it was started already, is not ready, or is unknown. A
     *  second started session of the enrollment is SessionOpen. */
    markStarted: async (sessionId: string): Promise<boolean> => {
      if (!UUID_RE.test(sessionId)) return false;
      // Read first: a failed statement aborts the transaction, so the error's
      // enrollment cannot be read after the violation.
      const [row] = await tx.select({ enrollmentId: sessions.enrollmentId }).from(sessions).where(eq(sessions.id, sessionId));
      if (!row) return false;
      try {
        const rows = await tx
          .update(sessions)
          .set({ startedAt: sql`now()` })
          .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'ready'), isNull(sessions.startedAt)))
          .returning({ id: sessions.id });
        return rows.length > 0;
      } catch (error) {
        if (isUniqueViolation(error)) throw new SessionOpen(row.enrollmentId);
        throw error;
      }
    },

    /** Phase 43 (spec D1, D6). The enrollment's open sessions: the started one
     *  and the one in stock, each when there is one. */
    findOpen: async (enrollmentId: string): Promise<{ started?: SessionSummary; stock?: SessionSummary }> => {
      const rows = await tx.execute<{
        id: string;
        status: string;
        source: string;
        started: boolean;
        answered: number;
        total: number;
      }>(sql`
        SELECT s.id, s.status, s.source, s.started_at IS NOT NULL AS started,
               (SELECT count(*) FROM answers a WHERE a.session_id = s.id)::int AS answered,
               (SELECT count(*) FROM session_questions q WHERE q.session_id = s.id)::int AS total
        FROM sessions s
        WHERE s.enrollment_id = ${enrollmentId} AND s.status IN ('preparing', 'ready')`);
      const open: { started?: SessionSummary; stock?: SessionSummary } = {};
      for (const { started, ...row } of rows.rows) {
        const summary = { ...row, status: row.status as SessionStatus, source: row.source as SessionSource };
        if (started) open.started = summary;
        else open.stock = summary;
      }
      return open;
    },

    /** Phase 43 (spec D4). The glosses a session asks, each once. */
    findSessionGlosses: async (sessionId: string): Promise<string[]> => {
      if (!UUID_RE.test(sessionId)) return [];
      const rows = await tx
        .selectDistinct({ glossId: questions.glossId })
        .from(sessionQuestions)
        .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
        .where(eq(sessionQuestions.sessionId, sessionId));
      return rows.map((row) => row.glossId);
    },

    /** Phase 43 (spec D3). What the enrollment's newest session was built for:
     *  a stock built with no device in hand inherits it. */
    findNewestDevices: async (enrollmentId: string): Promise<Devices | undefined> => {
      const [row] = await tx
        .select({ listening: sessions.listening, speaking: sessions.speaking })
        .from(sessions)
        .where(eq(sessions.enrollmentId, enrollmentId))
        .orderBy(sql`${sessions.createdAt} desc, ${sessions.id} desc`)
        .limit(1);
      return row;
    },

    /** Phase 53 (spec D12). What a session was chosen for: the learner day its words were
     *  chosen (null for a seed and for a session from before this phase) and the devices it
     *  was built for, which a rebuilt stock inherits. Undefined for an unknown or malformed id. */
    findStockChoice: async (
      sessionId: string,
    ): Promise<{ chosenOn: string | null; listening: boolean; speaking: boolean } | undefined> => {
      if (!UUID_RE.test(sessionId)) return undefined;
      const [row] = await tx
        .select({ chosenOn: sessions.chosenOn, listening: sessions.listening, speaking: sessions.speaking })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return row;
    },

    /** Phase 53 (spec D12). Retires a stock: only a list session nobody has started, in
     *  stock (preparing or ready), becomes skipped; true when this call did it. It is
     *  conditional like markStarted, so a start that wins the race leaves the session
     *  alone and this answers false. No practice_day: a retired stock never counted for a
     *  day, which is also what tells it from a session the learner skipped. */
    retireStock: async (sessionId: string): Promise<boolean> => {
      if (!UUID_RE.test(sessionId)) return false;
      const rows = await tx
        .update(sessions)
        .set({ status: 'skipped' })
        .where(
          and(
            eq(sessions.id, sessionId),
            inArray(sessions.status, ['preparing', 'ready']),
            isNull(sessions.startedAt),
            eq(sessions.source, 'list'),
          ),
        )
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    insertSessionQuestions,

    /** Phase 37 (spec D7). Every answer about a saved gloss, given while it was
     *  saved, in this enrollment's sessions that count for `day`, and in an open
     *  one, which counts as today; decoded as a session's evidence is. An answer
     *  from before the save is no evidence, as it writes no memory (phase 35 D4).
     *  In answer order: sessions as they were created (one is answered at a time,
     *  and a stock is always created after the session it waits behind), each in
     *  its positions' order. */
    findAnswersOn: async (enrollmentId: string, day: string): Promise<DayAnswer[]> => {
      const rows = await tx.execute<AnswerRow & { session_id: string }>(sql`
        SELECT s.id AS session_id, q.gloss_id, q.type, q.options, a.selected_option_position, a.verdict, a.retry_verdict
        FROM answers a
        JOIN sessions s            ON s.id = a.session_id
        JOIN questions q           ON q.id = a.question_id
        JOIN vocabulary_entries ve ON ve.enrollment_id = s.enrollment_id AND ve.gloss_id = q.gloss_id
        WHERE s.enrollment_id = ${enrollmentId}
          AND a.answered_at >= ve.created_at
          AND (s.practice_day = ${day}::date OR s.status IN ('preparing', 'ready'))
        ORDER BY s.created_at, s.id, a.position`);
      return rows.rows.map((row) => ({ ...decodeAnswer(row), sessionId: row.session_id }));
    },

    /** Phase 35 (spec D5, D10), phase 37 (D7). The glosses `day` introduced: saved
     *  glosses whose first answer given while saved is in a session counting for
     *  `day`, an open session counting as it. An answer from before the save is no
     *  introduction, as it writes no memory (D4). Sorted. */
    findIntroducedOn: async (enrollmentId: string, day: string): Promise<string[]> => {
      const rows = await tx.execute<{ gloss_id: string }>(sql`
        SELECT q.gloss_id
        FROM answers a
        JOIN sessions s            ON s.id = a.session_id
        JOIN questions q           ON q.id = a.question_id
        JOIN vocabulary_entries ve ON ve.enrollment_id = s.enrollment_id AND ve.gloss_id = q.gloss_id
        WHERE s.enrollment_id = ${enrollmentId}
          AND a.answered_at >= ve.created_at
          AND (s.practice_day IS NOT NULL OR s.status IN ('preparing', 'ready'))
        GROUP BY q.gloss_id
        HAVING min(coalesce(s.practice_day, ${day}::date)) = ${day}::date
        ORDER BY q.gloss_id`);
      return rows.rows.map((row) => row.gloss_id);
    },

    /** Phase 29 (spec D13). Whose list a session belongs to, so a use case
     *  addressed by a session id can authorize before it reads anything else.
     *  A malformed id is an absent one, as everywhere in this module. */
    findEnrollmentId: async (sessionId: string): Promise<string | undefined> => {
      if (!UUID_RE.test(sessionId)) return undefined;
      const [row] = await tx
        .select({ enrollmentId: sessions.enrollmentId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return row?.enrollmentId;
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
     *  Conditional so a job finishing after a skip changes nothing. A change
     *  that ends the session names its `practiceDay` (phase 35, D10). */
    transition: async (
      sessionId: string,
      from: SessionStatus[],
      to: SessionStatus,
      practiceDay?: string,
    ): Promise<boolean> => {
      if (!UUID_RE.test(sessionId)) return false;
      const rows = await tx
        .update(sessions)
        .set(practiceDay === undefined ? { status: to } : { status: to, practiceDay })
        .where(and(eq(sessions.id, sessionId), inArray(sessions.status, from)))
        .returning({ id: sessions.id });
      return rows.length > 0;
    },

    /** The enrollment's newest session: whether there has been any, and
     *  (phase 43, spec D6) whether the newest failed. Served by
     *  sessions_enrollment_created_idx. */
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
          retryState: answers.retryState,
          retryText: answers.retryText,
          retryVerdict: answers.retryVerdict,
        })
        .from(answers)
        .where(eq(answers.sessionId, sessionId))
        .orderBy(asc(answers.position));

      // answers_kind_valid: an answer is an option or a text with its verdict.
      // Phase 34 (spec D9): answers_retry_*, a retry only on a text's
      // `alternative`, with its text and verdict once resolved.
      const answerRecords: AnswerRecord[] = answerRows.map((answer) => {
        if (answer.typedText !== null) {
          const verdict = answer.verdict as AnswerVerdict;
          return {
            question_id: answer.questionId,
            is_correct: verdictCorrect(verdict),
            answer_string: answer.typedText,
            verdict,
            retry_state: answer.retryState as AnswerRecord['retry_state'],
            retry_answer_string: answer.retryText,
            retry_verdict: answer.retryVerdict as AnswerVerdict | null,
          };
        }
        const chosen = canonicalOptions(questionRows[answer.position].options!)[answer.selectedOptionPosition!];
        return {
          question_id: answer.questionId,
          is_correct: chosen.is_correct,
          answer_string: chosen.text,
          retry_state: null,
          retry_answer_string: null,
          retry_verdict: null,
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
     * (phase 23) is stored as its text and the verdict the learner was shown. A spoken
     * answer (phase 25) is stored the same way: the transcript, or '' for a
     * pass, and its verdict. Phase 34 (spec D9): `pending` holds it for its
     * second try. Phase 38 (spec D4): `hintOpened`, a typed cloze's hint.
     */
    insertAnswer: async (
      sessionId: string,
      position: number,
      questionId: string,
      answer: { displayIndex: number } | { text: string; verdict: AnswerVerdict; pending?: true; hintOpened?: boolean | null },
    ): Promise<void> => {
      if ('text' in answer) {
        await tx.insert(answers).values({
          sessionId,
          position,
          questionId,
          typedText: answer.text,
          verdict: answer.verdict,
          retryState: answer.pending ? 'pending' : null,
          hintOpened: answer.hintOpened ?? null,
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

    /** Phase 34 (spec D9). The pending answer at `position` takes its retry's
     *  text and verdict, and is resolved. Only a pending one: the session row is
     *  locked (loadSession), so finding none is a caller's mistake, not a race. */
    resolveRetry: async (
      sessionId: string,
      position: number,
      retry: { text: string; verdict: AnswerVerdict },
    ): Promise<void> => {
      const rows = await tx
        .update(answers)
        .set({ retryState: 'resolved', retryText: retry.text, retryVerdict: retry.verdict })
        .where(and(eq(answers.sessionId, sessionId), eq(answers.position, position), eq(answers.retryState, 'pending')))
        .returning({ position: answers.position });
      if (rows.length === 0) throw new Error(`session ${sessionId} has no pending answer at position ${position}`);
    },

    /** Phase 34 (spec D9). Resolves the session's pending answer, if it has one,
     *  with `retry`: a skip ends the card as "show the answer" would. */
    resolvePendingRetry: async (sessionId: string, retry: { text: string; verdict: AnswerVerdict }): Promise<void> => {
      await tx
        .update(answers)
        .set({ retryState: 'resolved', retryText: retry.text, retryVerdict: retry.verdict })
        .where(and(eq(answers.sessionId, sessionId), eq(answers.retryState, 'pending')));
    },

    completeSession: (sessionId: string, practiceDay: string): Promise<unknown> =>
      tx
        .update(sessions)
        .set({ completedAt: sql`now()`, status: 'completed', practiceDay })
        .where(eq(sessions.id, sessionId)),
  };
}

export type SessionRepo = ReturnType<typeof createSessionRepo>;

// The injected factory's type. Typing only this would leave the hole open: since
// `Tx` is assignable to `Db`, a `Db`-taking factory still satisfies it by
// parameter contravariance — so `createSessionRepo` itself must take a `Tx`.
export type CreateSessionRepo = (tx: Tx) => SessionRepo;

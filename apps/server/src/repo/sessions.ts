import type { AnswerRecord, AnswerVerdict, Question, SessionSource, SessionStatus } from '@lang-tutor/core/api';
import { verdictCorrect, type QuestionType } from '@lang-tutor/core/domain';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type { Devices, Path, SessionRecord, SessionState, SessionSummary, SkippedType } from '../domain/session';
import type { Explanation } from '../domain/explain';
import type { Tap } from '../domain/taps';
import type { DayAnswer } from '../domain/today';
import {
  answerExplanations,
  answerTaps,
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
import { decodeAnswer, tapMissType, type AnswerRow } from './progress';
import { canonicalOptions, questionColumns, questionFrom, withBoards } from './questions';

// `sessions.id` is a `uuid` column: a malformed value makes Postgres raise
// 22P02 (invalid input syntax for type uuid) before a WHERE clause can even
// run, which would otherwise surface as an uncaught 500 rather than the
// "not found" a bad id actually means. Reject the shape first so a malformed
// id is indistinguishable from an id that is merely absent.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Phase 57 (spec D1, ADR 0014). The sessions of one path: a target's, or the main path's
 *  (target_id null). */
const onPath = (path: Path): SQL => (path === null ? sql`s.target_id IS NULL` : sql`s.target_id = ${path}::uuid`);

export function createSessionRepo(tx: Tx) {
  /** Phase 37 (spec D7), phase 59 (spec D4). Every answer about a saved gloss, given while it was
   *  saved, in this enrollment's sessions `where` keeps (`s`), with a tapped list word's miss
   *  right after its card's answer; each with its session and that session's path, decoded as a
   *  session's evidence is, in answer order (findAnswersOn). */
  async function findAnswersWhere(enrollmentId: string, where: SQL): Promise<(DayAnswer & { targetId: Path })[]> {
    // Phase 59 (spec D4): a tapped list word's miss, right after its card's answer.
    const rows = await tx.execute<AnswerRow & { session_id: string; target_id: string | null }>(sql`
      SELECT e.session_id, s.target_id::text AS target_id, e.gloss_id, e.type, e.options, e.selected_option_position, e.verdict, e.retry_verdict, e.intro, e.helped
      FROM (
        SELECT a.session_id, q.gloss_id, q.type::text AS type, q.options, a.selected_option_position, a.verdict, a.retry_verdict, q.intro,
               a.answered_at, a.position, -1 AS word_index, coalesce(a.helped, false) AS helped
        FROM answers a
        JOIN questions q ON q.id = a.question_id
        UNION ALL
        SELECT tp.session_id, tp.gloss_id, ${tapMissType}, NULL::jsonb, NULL::integer, 'wrong', NULL::text, false,
               a.answered_at, tp.position, tp.word_index, false
        FROM answer_taps tp
        JOIN answers a ON a.session_id = tp.session_id AND a.position = tp.position
        -- Phase 62 (spec D4): the card the tap was on decides what it missed.
        JOIN questions q ON q.id = a.question_id
        WHERE tp.kind = 'list'
      ) e
      JOIN sessions s            ON s.id = e.session_id
      JOIN vocabulary_entries ve ON ve.enrollment_id = s.enrollment_id AND ve.gloss_id = e.gloss_id
      WHERE s.enrollment_id = ${enrollmentId}
        AND e.answered_at >= ve.created_at
        AND ${where}
      ORDER BY s.created_at, s.id, e.position, e.word_index`);
    return rows.rows.map((row) => ({ ...decodeAnswer(row), sessionId: row.session_id, targetId: row.target_id }));
  }

  // The two open-session indexes (phase 43: one in stock, one started; phase 57: per
  // path) are the only unique constraints on this table, so a unique violation here
  // means exactly "this path already has an open session of that kind".
  async function insertSessionRow(values: {
    userId: string;
    enrollmentId: string;
    status: SessionStatus;
    source: SessionSource;
    listening: boolean;
    speaking: boolean;
    chosenOn?: string;
    targetId?: string | null;
    kind?: 'practice' | 'question_types';
    newWordsHeld?: number;
    dayNewCap?: number;
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
     *  Phase 43 (spec D1): every session records what it was built for. Phase 57 (spec
     *  D2): the seed is the main path's. */
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
     *  D12): `chosenOn` is the learner day its words were chosen. Phase 57 (spec D1): on
     *  `path`. Phase 70 (spec D4): `held`, the new words the day's cap held back from the choice
     *  and the cap it read; absent, none and no cap, as the columns' defaults. */
    insertPreparingSession: (
      userId: string,
      enrollmentId: string,
      devices: Devices,
      chosenOn: string,
      path: Path,
      held?: { count: number; dayCap: number },
    ): Promise<string> =>
      insertSessionRow({
        userId,
        enrollmentId,
        status: 'preparing',
        source: 'list',
        chosenOn,
        targetId: path,
        ...devices,
        ...(held ? { newWordsHeld: held.count, dayNewCap: held.dayCap } : {}),
      }),

    /** Phase 70 (spec D4, D5). What a session recorded of the new words its choice held back. */
    findHeldNewWords: async (sessionId: string): Promise<{ count: number; dayCap: number | null; chosenOn: string | null } | undefined> => {
      if (!UUID_RE.test(sessionId)) return undefined;
      const [row] = await tx
        .select({ count: sessions.newWordsHeld, dayCap: sessions.dayNewCap, chosenOn: sessions.chosenOn })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return row;
    },

    /** Phase 61 (spec D3). A tester's session of one word's question types, preparing. A list
     *  session to every reader of `source`, chosen on no day, so no stale check replaces it.
     *  Phase 57 (ADR 0014): on `path`, which its one caller names as the main path. */
    insertQuestionTypesSession: (userId: string, enrollmentId: string, devices: Devices, path: Path): Promise<string> =>
      insertSessionRow({ userId, enrollmentId, status: 'preparing', source: 'list', kind: 'question_types', targetId: path, ...devices }),

    /** Phase 61 (spec D5). The chosen types a question-types session has no card for. */
    setSkippedTypes: async (sessionId: string, skipped: SkippedType[]): Promise<void> => {
      await tx.update(sessions).set({ skippedTypes: skipped }).where(eq(sessions.id, sessionId));
    },

    /** Phase 43 (review C1). Serializes, per path (phase 57), the use cases that make
     *  its next session, create and the stock job: the second waits for the
     *  first to commit, then reads what it made rather than racing it into the
     *  index. Held to the end of the transaction. A use case that takes more than one
     *  takes the main path's first, then the targets' in id order (services/stock.ts
     *  lockPaths), so two never wait on each other. */
    lockNextSession: async (enrollmentId: string, path: Path): Promise<void> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`next-session:${enrollmentId}:${path ?? 'main'}`}, 0))`);
    },

    /** Phase 43 (spec D2). Starts a ready session: true when this call started
     *  it, false when it was started already, is not ready, or is unknown. A
     *  second started session of its path (phase 57) is SessionOpen. */
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

    /** Phase 43 (spec D1, D6). A path's open sessions (phase 57): the started one
     *  and the one in stock, each when there is one. */
    findOpen: async (enrollmentId: string, path: Path): Promise<{ started?: SessionSummary; stock?: SessionSummary }> => {
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
        WHERE s.enrollment_id = ${enrollmentId} AND ${onPath(path)} AND s.status IN ('preparing', 'ready')`);
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

    /** Phase 57 (spec D2, ruling T3-j). A session's cards, in position order: the gloss each
     *  asks, its type, and whether it is one of a ladder's intro stage. */
    /** Final review I1-c. When a session's last answer was given, or null with none: a target's
     *  end skips its started session on that answer's learner day. */
    findLastAnswerAt: async (sessionId: string): Promise<Date | null> => {
      if (!UUID_RE.test(sessionId)) return null;
      const [row] = await tx
        .select({ ms: sql<number | null>`(extract(epoch from max(${answers.answeredAt})) * 1000)::float8` })
        .from(answers)
        .where(eq(answers.sessionId, sessionId));
      return row?.ms === null || row?.ms === undefined ? null : new Date(Number(row.ms));
    },

    findSessionCards: async (sessionId: string): Promise<{ glossId: string; type: QuestionType; intro: boolean; answered: boolean }[]> => {
      if (!UUID_RE.test(sessionId)) return [];
      const rows = await tx
        .select({ glossId: questions.glossId, type: questions.type, intro: questions.intro, answered: sql<boolean>`${answers.sessionId} IS NOT NULL` })
        .from(sessionQuestions)
        .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
        // Phase 68 (spec D1): whether the card is answered, which the open step-downs read.
        .leftJoin(answers, and(eq(answers.sessionId, sessionQuestions.sessionId), eq(answers.position, sessionQuestions.position)))
        .where(eq(sessionQuestions.sessionId, sessionId))
        .orderBy(asc(sessionQuestions.position));
      return rows.map((row) => ({ glossId: row.glossId, type: row.type as QuestionType, intro: row.intro, answered: row.answered }));
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
     *  its positions' order. Phase 57 (spec D1): each with the path of its session.
     *  Sessions of two paths can be answered at once, so "answer order" is now creation
     *  order across paths, which dayState's returns read, as before. */
    /** Phase 68 (spec D1). Every answer on a target's path, every day's and its open session's, as
     *  findAnswersOn reads one, in answer order: what its open step-downs are read from. */
    findPathAnswers: (enrollmentId: string, targetId: string): Promise<(DayAnswer & { targetId: Path })[]> =>
      UUID_RE.test(targetId) ? findAnswersWhere(enrollmentId, onPath(targetId)) : Promise.resolve([]),

    findAnswersOn: (enrollmentId: string, day: string): Promise<(DayAnswer & { targetId: Path })[]> =>
      findAnswersWhere(enrollmentId, sql`(s.practice_day = ${day}::date OR s.status IN ('preparing', 'ready'))`),

    /** Phase 65 (spec D7.1). Every answer as findAnswersOn reads one, in this enrollment's
     *  sessions that counted for one of its last `days` practice days up to `day`: the days its
     *  ended sessions hold an answer on, an open session counting for none. The budget's miss
     *  rate reads them. */
    findRecentAnswers: (enrollmentId: string, day: string, days: number): Promise<(DayAnswer & { targetId: Path })[]> =>
      findAnswersWhere(
        enrollmentId,
        sql`s.practice_day IN (
          SELECT DISTINCT d.practice_day
          FROM sessions d
          WHERE d.enrollment_id = ${enrollmentId}
            AND d.practice_day <= ${day}::date
            AND EXISTS (SELECT 1 FROM answers da WHERE da.session_id = d.id)
          ORDER BY d.practice_day DESC
          LIMIT ${days})`,
      ),

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

    /** Phase 73 (spec D2). The sessions that count for a My words `day`: completed, on the main
     *  path, a practice of the learner's list (no seed, no tester's question-types session),
     *  ended on that learner day. Oldest first. */
    findCountedMainSessions: async (enrollmentId: string, day: string): Promise<string[]> => {
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT s.id
        FROM sessions s
        WHERE s.enrollment_id = ${enrollmentId}
          AND ${onPath(null)}
          AND s.kind = 'practice'
          AND s.source = 'list'
          AND s.status = 'completed'
          AND s.practice_day = ${day}::date
        ORDER BY s.completed_at, s.id`);
      return rows.rows.map((row) => row.id);
    },

    /** Phase 73 (spec D3). Per saved gloss, the session of its first answer given while saved,
     *  over every session of every path, open ones too (as findIntroducedOn reads it), by
     *  answer time, kept when that session counts for `day` (an open one never does): the words a day's My words sessions introduced. */
    findFirstAnswerSessions: async (enrollmentId: string, day: string): Promise<{ glossId: string; sessionId: string }[]> => {
      const rows = await tx.execute<{ gloss_id: string; session_id: string; practice_day: string | null }>(sql`
        SELECT DISTINCT ON (q.gloss_id) q.gloss_id, s.id AS session_id, s.practice_day::text AS practice_day
        FROM answers a
        JOIN sessions s            ON s.id = a.session_id
        JOIN questions q           ON q.id = a.question_id
        JOIN vocabulary_entries ve ON ve.enrollment_id = s.enrollment_id AND ve.gloss_id = q.gloss_id
        WHERE s.enrollment_id = ${enrollmentId}
          AND a.answered_at >= ve.created_at
          AND (s.practice_day IS NOT NULL OR s.status IN ('preparing', 'ready'))
        ORDER BY q.gloss_id, a.answered_at`);
      return rows.rows
        .filter((row) => row.practice_day === day)
        .map((row) => ({ glossId: row.gloss_id, sessionId: row.session_id }));
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
          targetId: sessions.targetId,
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

    /** Phase 65 (spec D7.3). How many of `path`'s sessions were completed on `day`: those whose
     *  practice_day it is, a session started the day before and ended on it among them. */
    countCompletedOn: async (enrollmentId: string, path: Path, day: string): Promise<number> => {
      const rows = await tx.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count
        FROM sessions s
        WHERE s.enrollment_id = ${enrollmentId}
          AND ${onPath(path)}
          AND s.status = 'completed'
          AND s.practice_day = ${day}::date`);
      return rows.rows[0].count;
    },

    /** The enrollment's newest session: whether there has been any, and
     *  (phase 43, spec D6) whether the newest failed. Served by
     *  sessions_enrollment_created_idx. Phase 57 (spec D1): the newest of `path`'s sessions,
     *  or of any path's. */
    findLatest: async (enrollmentId: string, path: Path | 'any'): Promise<SessionSummary | undefined> => {
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
        WHERE s.enrollment_id = ${enrollmentId} AND ${path === 'any' ? sql`true` : onPath(path)}
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
          skippedTypes: sessions.skippedTypes,
          targetId: sessions.targetId,
          kind: sessions.kind,
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
          helped: answers.helped,
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
          // Phase 63 (spec D11): the right option chosen after help is a miss.
          is_correct: chosen.is_correct && answer.helped !== true,
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
        ...(session.skippedTypes === null ? {} : { skipped_types: session.skippedTypes as SkippedType[] }),
        ...(session.targetId === null ? {} : { target_id: session.targetId }),
        kind: session.kind as 'practice' | 'question_types',
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
     * second try. Phase 38 (spec D4): `hintOpened`, a typed cloze's hint. Phase 55
     * (spec D6): `helped`, help used on a tiles or typed card.
     */
    /** Phase 59 (spec D5). A card's taps, one row per word: a word already
     *  stored adds nothing, so a replay or a second try re-sending it writes no
     *  second miss. Answers the taps this call added. */
    insertTaps: async (sessionId: string, position: number, taps: readonly Tap[]): Promise<Tap[]> => {
      if (taps.length === 0) return [];
      const rows = await tx
        .insert(answerTaps)
        .values(taps.map((tap) => ({ sessionId, position, wordIndex: tap.index, kind: tap.kind, glossId: tap.glossId })))
        .onConflictDoNothing()
        .returning({ wordIndex: answerTaps.wordIndex });
      const added = new Set(rows.map((row) => row.wordIndex));
      return taps.filter((tap) => added.has(tap.index));
    },

    insertAnswer: async (
      sessionId: string,
      position: number,
      questionId: string,
      answer:
        | { displayIndex: number; helped?: boolean | null }
        | { text: string; verdict: AnswerVerdict; pending?: true; hintOpened?: boolean | null; helped?: boolean | null },
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
          helped: answer.helped ?? null,
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
        // Phase 63 (spec D11): a choice after help, read back as a miss.
        helped: answer.helped ?? null,
      });
    },

    /** Phase 66 (spec D2). The explanation stored for the answer at `position`. */
    findExplanation: async (sessionId: string, position: number): Promise<Explanation | null> => {
      const [row] = await tx
        .select({ corrected: answerExplanations.corrected, mistakes: answerExplanations.mistakes })
        .from(answerExplanations)
        .where(and(eq(answerExplanations.sessionId, sessionId), eq(answerExplanations.position, position)));
      return row ?? null;
    },

    /** Phase 66 (spec D2). Stores an explanation; the first stored stands, so two
     *  overlapping requests read back the same one. */
    insertExplanation: async (sessionId: string, position: number, explained: Explanation & { text: string }): Promise<void> => {
      await tx
        .insert(answerExplanations)
        .values({ sessionId, position, text: explained.text, corrected: explained.corrected, mistakes: explained.mistakes })
        .onConflictDoNothing();
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

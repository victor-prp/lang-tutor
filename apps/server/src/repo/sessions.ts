import type { AnswerRecord, Question } from '@lang-tutor/core/api';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import type { SessionRecord } from '../domain/session';
import {
  answers,
  questions,
  sessionQuestions,
  sessions,
  termVariants,
  type QuestionOption,
} from '../db/schema';
import { canonicalOptions, questionFrom } from './questions';

// `sessions.id` is a `uuid` column: a malformed value makes Postgres raise
// 22P02 (invalid input syntax for type uuid) before a WHERE clause can even
// run, which would otherwise surface as an uncaught 500 rather than the
// "not found" a bad id actually means. Reject the shape first so a malformed
// id is indistinguishable from an id that is merely absent.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSessionRepo(tx: Tx) {
  return {
    /**
     * `picked` comes from `pickQuestions`, so its options are already shuffled.
     * Each option's text is mapped back to its canonical position to build
     * `option_order` — unambiguous because `question_options_valid` guarantees
     * distinct texts within a question.
     */
    insertSession: async (userId: string, picked: Question[]): Promise<string> => {
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
        rows.map((row) => [row.id, canonicalOptions(row.options)]),
      );

      const [session] = await tx.insert(sessions).values({ userId }).returning({ id: sessions.id });

      await tx.insert(sessionQuestions).values(
        picked.map((question, position) => {
          const canonical = canonicalById.get(question.id);
          if (!canonical) throw new Error(`question ${question.id} is not in the database`);
          return {
            sessionId: session.id,
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

      return session.id;
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
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for('update');
      if (!session) return undefined;

      const questionRows = await tx
        .select({
          id: questions.id,
          options: questions.options,
          form: termVariants.form,
          termId: termVariants.termId,
          optionOrder: sessionQuestions.optionOrder,
        })
        .from(sessionQuestions)
        .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
        .innerJoin(termVariants, eq(termVariants.id, questions.promptVariantId))
        .where(eq(sessionQuestions.sessionId, sessionId))
        .orderBy(asc(sessionQuestions.position));

      const answerRows = await tx
        .select({
          position: answers.position,
          questionId: answers.questionId,
          selectedOptionPosition: answers.selectedOptionPosition,
        })
        .from(answers)
        .where(eq(answers.sessionId, sessionId))
        .orderBy(asc(answers.position));

      const answerRecords: AnswerRecord[] = answerRows.map((answer) => {
        const chosen = canonicalOptions(questionRows[answer.position].options)[
          answer.selectedOptionPosition
        ];
        return {
          question_id: answer.questionId,
          is_correct: chosen.is_correct,
          answer_string: chosen.text,
        };
      });

      return {
        user_id: session.userId,
        questions: questionRows.map((row) => questionFrom(row, row.optionOrder)),
        answers: answerRecords,
        complete: session.completedAt !== null,
        completed_at: session.completedAt === null ? null : session.completedAt.getTime(),
      };
    },

    /**
     * `displayIndex` is the index the learner saw. Translating it to the option's
     * authored position is this module's own business — `option_order` is the
     * encoding `insertSession` wrote, so nothing above needs to know it exists.
     * The extra lookup is one primary-key read inside a transaction that is
     * already holding this session's row.
     */
    insertAnswer: async (
      sessionId: string,
      position: number,
      questionId: string,
      displayIndex: number,
    ): Promise<void> => {
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
        selectedOptionPosition: row.optionOrder[displayIndex],
      });
    },

    completeSession: (sessionId: string): Promise<unknown> =>
      tx.update(sessions).set({ completedAt: sql`now()` }).where(eq(sessions.id, sessionId)),
  };
}

export type SessionRepo = ReturnType<typeof createSessionRepo>;

// The injected factory's type. Typing only this would leave the hole open: since
// `Tx` is assignable to `Db`, a `Db`-taking factory still satisfies it by
// parameter contravariance — so `createSessionRepo` itself must take a `Tx`.
export type CreateSessionRepo = (tx: Tx) => SessionRepo;

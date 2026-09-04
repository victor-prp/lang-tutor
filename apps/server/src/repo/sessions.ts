import type { AnswerRecord, Question } from '@lang-tutor/core/api';
import { asc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import type { SessionRecord } from '../domain/session';
import {
  answers,
  questions,
  sessionQuestions,
  sessions,
  termVariants,
  users,
  type QuestionOption,
} from '../db/schema';
import { canonicalOptions, questionFrom } from './questions';

export type LoadedSession = {
  record: SessionRecord;
  /** `optionOrders[i][displayIndex]` is the canonical option position shown at that index. */
  optionOrders: number[][];
};

export function createSessionRepo(db: Db) {
  return {
    /**
     * `user_id` is an unvalidated client UUID and there is no auth, so first
     * sight creates the row. Returns the language pair the session draws from.
     */
    upsertUser: async (userId: string) => {
      await db.insert(users).values({ id: userId }).onConflictDoNothing();
      const [row] = await db
        .select({ nativeLanguage: users.nativeLanguage, targetLanguage: users.targetLanguage })
        .from(users)
        .where(eq(users.id, userId));
      return row;
    },

    /**
     * `picked` comes from `pickQuestions`, so its options are already shuffled.
     * Each option's text is mapped back to its canonical position to build
     * `option_order` — unambiguous because `question_options_valid` guarantees
     * distinct texts within a question.
     */
    insertSession: async (userId: string, picked: Question[]): Promise<string> => {
      const rows = await db
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

      const [session] = await db.insert(sessions).values({ userId }).returning({ id: sessions.id });

      await db.insert(sessionQuestions).values(
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
    loadSession: async (sessionId: string): Promise<LoadedSession | undefined> => {
      const [session] = await db
        .select({
          id: sessions.id,
          userId: sessions.userId,
          completedAt: sessions.completedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for('update');
      if (!session) return undefined;

      const questionRows = await db
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

      const answerRows = await db
        .select({
          position: answers.position,
          questionId: answers.questionId,
          selectedOptionPosition: answers.selectedOptionPosition,
        })
        .from(answers)
        .where(eq(answers.sessionId, sessionId))
        .orderBy(asc(answers.position));

      const optionOrders = questionRows.map((row) => row.optionOrder);

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
        record: {
          user_id: session.userId,
          questions: questionRows.map((row) => questionFrom(row, row.optionOrder)),
          answers: answerRecords,
          complete: session.completedAt !== null,
          completed_at: session.completedAt === null ? null : session.completedAt.getTime(),
        },
        optionOrders,
      };
    },

    /** `canonicalPosition` is the option's authored position, not its display index. */
    insertAnswer: (
      sessionId: string,
      position: number,
      questionId: string,
      canonicalPosition: number,
    ): Promise<unknown> =>
      db.insert(answers).values({
        sessionId,
        position,
        questionId,
        selectedOptionPosition: canonicalPosition,
      }),

    completeSession: (sessionId: string): Promise<unknown> =>
      db.update(sessions).set({ completedAt: sql`now()` }).where(eq(sessions.id, sessionId)),
  };
}

export type SessionRepo = ReturnType<typeof createSessionRepo>;

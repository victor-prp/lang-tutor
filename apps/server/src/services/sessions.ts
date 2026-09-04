import type { SessionRecord } from '../domain/session';
import { newSessionRecord, sessionScore, step } from '../domain/session';
import type { Db } from '../db/client';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import { createQuestionRepo } from '../repo/questions';
import { createSessionRepo } from '../repo/sessions';

// The one place a completed session is logged. Redundant with the database,
// kept because it is output you can tail without opening psql.
function logCompletedSession(sessionId: string, record: SessionRecord): void {
  console.log(
    JSON.stringify({
      session_id: sessionId,
      user_id: record.user_id,
      questions: record.questions,
      answers: record.answers,
      score: sessionScore(record),
    }),
  );
}

/**
 * The application layer. Each use case is one transaction, opened here — a route
 * handler never opens one. The repositories are created from the transaction
 * handle inside, because that handle does not exist until the transaction does.
 */
export function createSessionService(db: Db) {
  return {
    startSession: (userId: string): Promise<{ sessionId: string; record: SessionRecord }> =>
      db.transaction(async (tx) => {
        const sessionRepo = createSessionRepo(tx);
        const questionRepo = createQuestionRepo(tx);

        const user = await sessionRepo.upsertUser(userId);
        const pool = await questionRepo.loadQuestionPool(
          user.targetLanguage,
          user.nativeLanguage,
          userId,
        );
        // No default rng: a server must not inherit Math.random by accident, so
        // this is the one place that names it.
        const record = newSessionRecord(userId, pool, Math.random);
        const sessionId = await sessionRepo.insertSession(userId, record.questions);
        return { sessionId, record };
      }),

    submitAnswer: (
      sessionId: string,
      questionId: string,
      optionIndex: number,
    ): Promise<SessionRecord> =>
      db.transaction(async (tx) => {
        const repo = createSessionRepo(tx);
        const loaded = await repo.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);

        const outcome = step(loaded.record, questionId, optionIndex);
        if (outcome.status === 'invalid_question') throw new QuestionDesynced(questionId);
        if (outcome.status === 'replayed') return outcome.record;

        const position = loaded.record.answers.length;
        const order = loaded.optionOrders[position];
        if (optionIndex >= order.length) throw new OptionOutOfRange(optionIndex);

        await repo.insertAnswer(sessionId, position, questionId, order[optionIndex]);

        if (outcome.justCompleted) {
          await repo.completeSession(sessionId);
          logCompletedSession(sessionId, outcome.record);
        }

        return outcome.record;
      }),
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

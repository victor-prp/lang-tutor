import type { SessionRecord } from '../domain/session';
import { newSessionRecord, sessionScore, step } from '../domain/session';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound, UserNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Transaction } from './transaction';

export type { Transaction } from './transaction';

// The one place a completed session is logged. Redundant with the database, kept
// because it is output you can tail without opening psql — structured, so you
// can grep it.
function logCompletedSession(logger: Logger, sessionId: string, record: SessionRecord): void {
  logger.info({
    session_id: sessionId,
    user_id: record.user_id,
    questions: record.questions,
    answers: record.answers,
    score: sessionScore(record),
  });
}

/**
 * The application layer. Each use case is one `transaction(...)` call, opened
 * here — a route handler never opens one.
 *
 * Every collaborator arrives in one deps object: nothing here reaches for a
 * source of randomness or an output stream.
 */
export function createSessionService({
  transaction,
  rng,
  logger,
}: {
  transaction: Transaction;
  rng: () => number;
  logger: Logger;
}) {
  return {
    startSession: (userId: string): Promise<{ sessionId: string; record: SessionRecord }> =>
      transaction(async ({ session, question, user }) => {
        const learner = await user.findById(userId);
        // No implicit creation. A session for an id nobody onboarded is a bug,
        // and the route turns this into a 404.
        if (!learner) throw new UserNotFound(userId);

        const pool = await question.loadQuestionPool(
          learner.target_language,
          learner.native_language,
          userId,
        );
        const record = newSessionRecord(userId, pool, rng);
        const sessionId = await session.insertSession(userId, record.questions);
        return { sessionId, record };
      }),

    submitAnswer: async (
      sessionId: string,
      questionId: string,
      optionIndex: number,
    ): Promise<SessionRecord> => {
      // The transaction returns its outcome and the log fires after it resolves:
      // a commit that fails after completeSession must not leave a log claiming a
      // session the database never recorded.
      const { record, justCompleted } = await transaction(async ({ session }) => {
        const loaded = await session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);

        // Three failure modes, three domain outcomes, three errors — the domain
        // decides what is wrong, this layer only names it.
        const outcome = step(loaded, questionId, optionIndex);
        if (outcome.status === 'invalid_question') throw new QuestionDesynced(questionId);
        if (outcome.status === 'out_of_range') throw new OptionOutOfRange(optionIndex);
        // A replay reports justCompleted: false, so retrying a completed session
        // logs nothing — exactly today's behaviour.
        if (outcome.status === 'replayed') {
          return { record: outcome.record, justCompleted: false };
        }

        await session.insertAnswer(sessionId, loaded.answers.length, questionId, optionIndex);

        if (outcome.justCompleted) {
          await session.completeSession(sessionId);
        }

        return { record: outcome.record, justCompleted: outcome.justCompleted };
      });

      if (justCompleted) {
        logCompletedSession(logger, sessionId, record);
      }

      return record;
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

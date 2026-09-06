import type { SessionRecord } from '../domain/session';
import { newSessionRecord, sessionScore, step } from '../domain/session';
import type { Db } from '../db/client';
import { OptionOutOfRange, QuestionDesynced, SessionNotFound } from '../errors';
import type { Logger } from '../logger';
import type { CreateQuestionRepo } from '../repo/questions';
import type { CreateSessionRepo } from '../repo/sessions';

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
 * The application layer. Each use case is one transaction, opened here — a route
 * handler never opens one. The repositories are created from the transaction
 * handle inside, because that handle does not exist until the transaction does.
 *
 * Every collaborator arrives in one deps object: nothing here reaches for a
 * source of randomness or an output stream.
 */
export function createSessionService({
  db,
  rng,
  logger,
  repos,
}: {
  db: Db;
  rng: () => number;
  logger: Logger;
  repos: { session: CreateSessionRepo; question: CreateQuestionRepo };
}) {
  return {
    startSession: (userId: string): Promise<{ sessionId: string; record: SessionRecord }> =>
      db.transaction(async (tx) => {
        const sessionRepo = repos.session(tx);
        const questionRepo = repos.question(tx);

        const user = await sessionRepo.upsertUser(userId);
        const pool = await questionRepo.loadQuestionPool(
          user.targetLanguage,
          user.nativeLanguage,
          userId,
        );
        const record = newSessionRecord(userId, pool, rng);
        const sessionId = await sessionRepo.insertSession(userId, record.questions);
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
      const { record, justCompleted } = await db.transaction(async (tx) => {
        const repo = repos.session(tx);
        const loaded = await repo.loadSession(sessionId);
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

        await repo.insertAnswer(sessionId, loaded.answers.length, questionId, optionIndex);

        if (outcome.justCompleted) {
          await repo.completeSession(sessionId);
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

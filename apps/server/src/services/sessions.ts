import type { SessionSource, SessionStatus } from '@lang-tutor/core/api';
import { LIVE_DIMENSIONS, shuffleOptions, type AnswerInput } from '@lang-tutor/core/domain';

import {
  buildDistractorPrompt,
  distractorItems,
  generatedContent,
  parseLlmDistractors,
  validateDistractors,
} from '../domain/distractors';
import { PREPARE_SESSION, PrepareSessionPayloadSchema } from '../domain/jobs';
import { evaluateSession, progressChanges, type ProgressChange } from '../domain/progress';
import type { SessionRecord, SessionSummary } from '../domain/session';
import {
  SESSION_LENGTH,
  isCurrent,
  isOpen,
  newSessionRecord,
  nextSource,
  pickSenses,
  sessionScore,
  step,
  typeFor,
} from '../domain/session';
import {
  AnswerKindMismatch,
  EnrollmentNotFound,
  InsufficientQuestions,
  InvalidDistractors,
  NoSavedWords,
  OptionOutOfRange,
  QuestionDesynced,
  SessionNotFound,
  SessionNotReady,
  SessionNotSkippable,
  SessionOpen,
} from '../errors';
import type { Logger } from '../logger';
import type { LlmClient } from './llm';
import type { Repos, Transaction } from './transaction';

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

/** A session as the routes answer it: the record, and what it did to the
 *  learner's saved words, which is empty until it is completed. */
export type SessionResult = SessionRecord & { progress: ProgressChange[] };

/**
 * Phase 20. Runs the progress rule over an ended session's answers, inside the
 * transaction that ended it. The status change and these writes are dependent
 * (ADR 0001 R8, spec §3): an ended session without its progress, or progress
 * for a session that did not end, would each be wrong.
 *
 * A sense with no rows is not saved, so it is skipped: that is the whole of
 * "only answers given while saved count". A session with no answers has no
 * evidence and writes nothing.
 */
async function recordProgress(repos: Repos, sessionId: string): Promise<void> {
  const evidence = await repos.progress.findSessionEvidence(sessionId);
  if (!evidence) return;
  const rows = await repos.progress.findRows({
    enrollmentId: evidence.enrollmentId,
    senseIds: [...new Set(evidence.answers.map((answer) => answer.senseId))],
    savedBy: null,
  });
  if (rows.length === 0) return;
  const outcome = evaluateSession(rows, evidence.answers, evidence.day);
  await repos.progress.updateRows({ enrollmentId: evidence.enrollmentId, rows: outcome.changed });
  await repos.progress.insertSnapshot({ sessionId, rows: outcome.snapshot });
}

/** What a completed session did, as badges. Empty for any other status. */
async function progressOf(repos: Repos, sessionId: string, record: SessionRecord): Promise<ProgressChange[]> {
  if (record.status !== 'completed') return [];
  return progressChanges(await repos.progress.findSnapshot(sessionId), LIVE_DIMENSIONS);
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
  llm,
}: {
  transaction: Transaction;
  rng: () => number;
  logger: Logger;
  llm: LlmClient;
}) {
  return {
    /**
     * The next session of an enrollment. The first is the seed, ready at once.
     * Every later one is built from the saved list: it is inserted as
     * `preparing`, and its prepare-session job is enqueued in this same
     * transaction, so the row and its job commit together. The open-session
     * check here gives the clean error; the unique index (repo -> SessionOpen)
     * is what holds under a race.
     */
    createNextSession: (
      enrollmentId: string,
    ): Promise<{ sessionId: string; status: SessionStatus; source: SessionSource }> =>
      transaction(async ({ session, question, enrollment, vocabulary, jobs }) => {
        const enrolled = await enrollment.findById(enrollmentId);
        // No implicit creation. The route turns this into a 404.
        if (!enrolled) throw new EnrollmentNotFound(enrollmentId);

        const latest = await session.findLatest(enrollmentId);
        if (latest && isOpen(latest.status)) throw new SessionOpen(enrollmentId);

        if (nextSource(latest !== undefined) === 'seed') {
          const pool = await question.loadQuestionPool(
            enrolled.target_language,
            enrolled.source_language,
          );
          // Checked here rather than left to pickQuestions, whose plain Error was a
          // 500: a language with no seeded questions is an answer, not a failure.
          if (pool.length < SESSION_LENGTH) throw new InsufficientQuestions(enrollmentId, pool.length);
          const record = newSessionRecord(enrolled.user_id, pool, rng);
          const sessionId = await session.insertSession(
            enrolled.user_id,
            enrollmentId,
            record.questions,
          );
          return { sessionId, status: 'ready' as const, source: 'seed' as const };
        }

        const saved = await vocabulary.listSavedSenses(enrollmentId);
        if (saved.length === 0) throw new NoSavedWords(enrollmentId);
        const picks = pickSenses(saved, SESSION_LENGTH, rng);
        const sessionId = await session.insertPreparingSession(enrolled.user_id, enrollmentId);
        await jobs.enqueue(PREPARE_SESSION, {
          session_id: sessionId,
          picks: picks.map((pick) => ({ sense_id: pick.senseId, variant_id: pick.variantId })),
        });
        return { sessionId, status: 'preparing' as const, source: 'list' as const };
      }),

    /** Resume and the poll both read through this. A completed session also
     *  carries what it did to the saved words. */
    getSession: (sessionId: string): Promise<SessionResult> =>
      transaction(async (repos) => {
        const record = await repos.session.loadSession(sessionId);
        if (!record) throw new SessionNotFound(sessionId);
        return { ...record, progress: await progressOf(repos, sessionId, record) };
      }),

    /** What the home screen needs in one read. */
    currentSession: (
      enrollmentId: string,
    ): Promise<{ current: SessionSummary | null; nextSource: SessionSource; savedCount: number }> =>
      transaction(async ({ session, enrollment, vocabulary }) => {
        if (!(await enrollment.findById(enrollmentId))) throw new EnrollmentNotFound(enrollmentId);
        const latest = await session.findLatest(enrollmentId);
        return {
          current: latest && isCurrent(latest.status) ? latest : null,
          nextSource: nextSource(latest !== undefined),
          savedCount: await vocabulary.countEntries(enrollmentId),
        };
      }),

    /**
     * Ends a preparing or ready session. Idempotent on `skipped`. A job still
     * generating for it finds the status changed at its final, conditional
     * write and writes nothing. A skip counts the answers given before it toward
     * progress.
     */
    skipSession: async (sessionId: string): Promise<void> => {
      const skipped = await transaction(async (repos) => {
        const state = await repos.session.findState(sessionId);
        if (!state) throw new SessionNotFound(sessionId);
        if (state.status === 'skipped') return false;
        if (!isOpen(state.status)) throw new SessionNotSkippable(sessionId, state.status);
        const changed = await repos.session.transition(sessionId, ['preparing', 'ready'], 'skipped');
        // Phase 20. The answers given before the skip are real answers.
        if (changed) await recordProgress(repos, sessionId);
        return changed;
      });
      if (skipped) logger.info({ event: 'session_skipped', session_id: sessionId });
    },

    /** `answer` is an option index for a choice and the typed text for a
     *  typed card (phase 23). A typed answer is judged here, by the same
     *  judgeTyped the app ran for its feedback, and stored with its verdict. */
    submitAnswer: async (
      sessionId: string,
      questionId: string,
      answer: AnswerInput,
    ): Promise<SessionResult> => {
      // The transaction returns its outcome and the log fires after it resolves:
      // a commit that fails after completeSession must not leave a log claiming a
      // session the database never recorded.
      const { result, justCompleted } = await transaction(async (repos) => {
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);

        // Phase 19. Preparing, skipped and failed sessions take no answers. A
        // completed one still reaches `step`, whose replay path answers a retry.
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }

        // Four failure modes, four domain outcomes, four errors — the domain
        // decides what is wrong, this layer only names it.
        const outcome = step(loaded, questionId, answer);
        if (outcome.status === 'invalid_question') throw new QuestionDesynced(questionId);
        if (outcome.status === 'wrong_answer_kind') throw new AnswerKindMismatch(questionId);
        if (outcome.status === 'out_of_range') {
          throw new OptionOutOfRange('option_index' in answer ? answer.option_index : -1);
        }
        // A replay reports justCompleted: false, so retrying a completed session
        // logs nothing and writes no progress.
        if (outcome.status === 'replayed') {
          const progress = await progressOf(repos, sessionId, outcome.record);
          return { result: { ...outcome.record, progress }, justCompleted: false };
        }

        const recorded = outcome.record.answers[loaded.answers.length];
        await repos.session.insertAnswer(
          sessionId,
          loaded.answers.length,
          questionId,
          'text' in answer
            ? { text: answer.text, verdict: recorded.verdict! }
            : { displayIndex: answer.option_index },
        );

        if (outcome.justCompleted) {
          await repos.session.completeSession(sessionId);
          await recordProgress(repos, sessionId);
        }

        const progress = await progressOf(repos, sessionId, outcome.record);
        return { result: { ...outcome.record, progress }, justCompleted: outcome.justCompleted };
      });

      if (justCompleted) {
        logCompletedSession(logger, sessionId, result);
      }

      return result;
    },

    /**
     * The prepare-session job: read, call the model, write. Three steps, so no
     * transaction is held across the model call (ADR 0001 R8). The status flip
     * and the question inserts are dependent writes and share the last
     * transaction. Any throw is a failed attempt, which pg-boss retries and,
     * once the retries are spent, dead-letters to failPreparation.
     *
     * `data` is parsed here rather than in worker.ts, which holds no logic. A
     * payload from an older deploy fails loudly instead of half-working.
     */
    prepareSession: async (data: unknown): Promise<void> => {
      const payload = PrepareSessionPayloadSchema.parse(data);
      const sessionId = payload.session_id;

      const read = await transaction(async ({ session, enrollment, question }) => {
        const state = await session.findState(sessionId);
        // Skipped, or gone (a reseed): nothing to prepare, and not a failure.
        if (!state || state.status !== 'preparing') return undefined;
        const enrolled = await enrollment.findById(state.enrollmentId);
        if (!enrolled) return undefined;
        const context = await question.findGenerationContext({
          picks: payload.picks.map((pick) => ({ senseId: pick.sense_id, variantId: pick.variant_id })),
          sourceLanguage: enrolled.source_language,
        });
        return { state, enrolled, context };
      });
      if (!read) {
        logger.info({ event: 'session_preparation_dropped', session_id: sessionId, stage: 'read' });
        return;
      }
      if (read.context.length === 0) {
        throw new InvalidDistractors(sessionId, 'none of the picked senses is in the dictionary any more');
      }

      // Phase 23 (spec D2). The picks are in random order already; position
      // decides the type, and the order is kept from here on.
      const types = read.context.map((_, index) => typeFor(index));
      const items = distractorItems(read.context, types);
      const raw = await llm(
        buildDistractorPrompt({
          items,
          from: read.enrolled.target_language,
          to: read.enrolled.source_language,
        }),
      );
      // An empty string is the provider's "no content" (a safety block). Here,
      // unlike a lookup, there is nothing useful to serve without it.
      const answer = raw === '' ? null : parseLlmDistractors(raw);
      if (!answer) throw new InvalidDistractors(sessionId, 'the model answer was unreadable');
      const verdict = validateDistractors(items, answer, read.enrolled.source_language);
      if (!verdict.ok) throw new InvalidDistractors(sessionId, verdict.reason);

      const written = await transaction(async ({ session, question }) => {
        // Conditional: a skip that landed during the model call wins, and this
        // transaction then writes nothing at all.
        if (!(await session.transition(sessionId, ['preparing'], 'ready'))) return false;
        const generated = await question.insertGeneratedQuestions({
          userId: read.state.userId,
          enrollmentId: read.state.enrollmentId,
          targetLanguage: read.enrolled.target_language,
          userLanguageCode: read.enrolled.source_language,
          questions: read.context.map((row, index) => ({
            senseId: row.senseId,
            variantId: row.variantId,
            form: row.form,
            lemma: row.lemma,
            partOfSpeech: row.partOfSpeech,
            lexemeId: row.lexemeId,
            type: types[index],
            ...generatedContent(row, types[index], verdict.byKey.get(items[index].key)!),
          })),
        });
        // Options are shuffled as a seed session's are; the question order is
        // not, because the type cycle is by position.
        await session.insertSessionQuestions(
          sessionId,
          generated.map((question) => shuffleOptions(question, rng)),
        );
        return true;
      });

      logger.info({
        event: written ? 'session_prepared' : 'session_preparation_dropped',
        session_id: sessionId,
        question_count: written ? read.context.length : 0,
        ...(written ? {} : { stage: 'write' }),
      });
    },

    /** The dead-letter handler: retries are spent or the job expired. Marks the
     *  session failed only while it is still preparing, so a skip stays a skip.
     *  It parses the session id alone: a payload prepareSession refused on every
     *  attempt (an older deploy, a hand-made job) reaches here unchanged, and
     *  refusing it again would leave the session preparing forever. */
    failPreparation: async (data: unknown): Promise<void> => {
      const { session_id: sessionId } = PrepareSessionPayloadSchema.pick({
        session_id: true,
      }).parse(data);
      const marked = await transaction(({ session }) =>
        session.transition(sessionId, ['preparing'], 'failed'),
      );
      logger.info({ event: 'session_preparation_failed', session_id: sessionId, marked });
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

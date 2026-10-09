import type { Enrollment, SessionSource, SessionStatus, SpeechVerdict, TypedVerdict } from '@lang-tutor/core/api';
import { LlmTranscriptSchema, TypedVerdictSchema } from '@lang-tutor/core/api/schemas';
import {
  LIVE_DIMENSIONS,
  MAX_JUDGED_TEXT,
  isJudged,
  isSpeaking,
  shuffleSession,
  speakable,
  spokenVerdict,
  type AnswerInput,
  type JudgedQuestion,
  type SpeakingQuestion,
} from '@lang-tutor/core/domain';

import { findGap } from '../domain/cloze';
import {
  NOTHING_GENERATED,
  boardMeanings,
  buildDistractorPrompt,
  distractorItems,
  generatedContent,
  keyOf,
  parseLlmDistractors,
  tasksFor,
  validateDistractors,
  withSiblingAlternatives,
  type DistractorVerdict,
} from '../domain/distractors';
import { judgePrompt, parseJudge, ruleVerdict, type JudgeContext } from '../domain/judge';
import { PREPARE_SESSION, PrepareSessionPayloadSchema } from '../domain/jobs';
import { LANGUAGES, type LanguageCode } from '../domain/languages';
import { BOARD_SIZE, planSession } from '../domain/plan';
import { evaluateSession, progressChanges, type ProgressChange } from '../domain/progress';
import type { SessionRecord, SessionSummary } from '../domain/session';
import {
  SESSION_LENGTH,
  askableRenderings,
  currentQuestion,
  isCurrent,
  isOpen,
  newSessionRecord,
  nextSource,
  pickGlosses,
  pickRendering,
  sessionScore,
  step,
} from '../domain/session';
import { MAX_AVOID } from '../domain/sentences';
import { MIN_AUDIO_CHARS, parseTranscript, transcriptionSystem } from '../domain/speech';
import { tileEligible, tilesFor } from '../domain/tiles';
import {
  AnswerKindMismatch,
  GlossLanguageMismatch,
  InsufficientQuestions,
  InvalidDistractors,
  LlmUnavailable,
  NoSavedWords,
  OptionOutOfRange,
  QuestionDesynced,
  SessionNotFound,
  SessionNotReady,
  SessionNotSkippable,
  SessionOpen,
} from '../errors';
import type { Logger } from '../logger';
import { authorizeEnrollment } from './access';
import type { LlmClient } from './llm';
import type { SpeechTranscriber } from './speech';
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

/** Phase 25. What one spoken attempt came to: the transcript, how it was
 *  judged, and the session when the answer was recorded (null when not). */
export type SpeechResult = { heard: string; verdict: SpeechVerdict; session: SessionResult | null };

/** Phase 27. A judged answer: its verdict, and the session it was recorded in. */
export type JudgedResult = { verdict: TypedVerdict; session: SessionResult };

/**
 * Phase 20. Runs the progress rule over an ended session's answers, inside the
 * transaction that ended it. The status change and these writes are dependent
 * (ADR 0001 R8, spec §3): an ended session without its progress, or progress
 * for a session that did not end, would each be wrong.
 *
 * A gloss with no rows is not saved, so it is skipped: that is the whole of
 * "only answers given while saved count". A session with no answers has no
 * evidence and writes nothing.
 *
 * Phase 31 (spec D14). The practised glosses' lexemes are share-locked before
 * anything is read, so a merge of one of them lands wholly before the evidence
 * is read or wholly after the progress is written: never between.
 */
async function recordProgress(repos: Repos, sessionId: string): Promise<void> {
  await repos.progress.lockSessionGlosses(sessionId);
  const evidence = await repos.progress.findSessionEvidence(sessionId);
  if (!evidence) return;
  const rows = await repos.progress.findRows({
    enrollmentId: evidence.enrollmentId,
    glossIds: [...new Set(evidence.answers.map((answer) => answer.glossId))],
    savedBy: null,
  });
  if (rows.length === 0) return;
  const outcome = evaluateSession(rows, evidence.answers, evidence.day);
  await repos.progress.updateRows({ enrollmentId: evidence.enrollmentId, rows: outcome.changed });
  await repos.progress.insertSnapshot({ sessionId, rows: outcome.snapshot });
}

/**
 * Phase 29 (spec D13, ADR 0009 R7). A use case addressed by a session id
 * authorizes against the session's enrollment before it reads anything else.
 * An unknown session is SessionNotFound, as before; another learner's is
 * AccessDenied. Answers the enrollment, so a caller needs no second read.
 */
async function authorizeSession(
  repos: Repos,
  logger: Logger,
  actorUserId: string,
  sessionId: string,
): Promise<Enrollment> {
  const enrollmentId = await repos.session.findEnrollmentId(sessionId);
  if (!enrollmentId) throw new SessionNotFound(sessionId);
  return authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'session.practice' });
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
  now,
  logger,
  llm,
  transcriber,
  judge,
}: {
  transaction: Transaction;
  rng: () => number;
  now: () => number;
  logger: Logger;
  llm: LlmClient;
  transcriber: SpeechTranscriber;
  judge: LlmClient;
}) {
  const service = {
    /**
     * The next session of an enrollment. The first is the seed, ready at once.
     * Every later one is built from the saved list: it is inserted as
     * `preparing`, and its prepare-session job is enqueued in this same
     * transaction, so the row and its job commit together. The open-session
     * check here gives the clean error; the unique index (repo -> SessionOpen)
     * is what holds under a race.
     */
    createNextSession: (
      actorUserId: string,
      enrollmentId: string,
      options: { listening: boolean; speaking: boolean },
    ): Promise<{ sessionId: string; status: SessionStatus; source: SessionSource }> =>
      transaction(async (repos) => {
        const { session, question, vocabulary, dict, jobs } = repos;
        // No implicit creation: an unknown enrollment is a 404, another
        // learner's a 403, both before anything is written.
        const enrolled = await authorizeEnrollment(repos, logger, {
          actorUserId,
          enrollmentId,
          permission: 'session.practice',
        });

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

        const saved = await vocabulary.listSavedGlosses(enrollmentId);
        if (saved.length === 0) throw new NoSavedWords(enrollmentId);
        // Phase 31 (spec D18). At most one gloss per key, across headwords.
        const picked = pickGlosses(saved, SESSION_LENGTH, rng);
        // Spec D12. One rendering per gloss, uniformly over every form of every
        // member that agrees with the gloss, the saved form always among them.
        // No model call: a lemma form not yet rendered joins once its job lands.
        const renderings = await dict.findGlossRenderings({
          glossIds: picked.map((gloss) => gloss.glossId),
          userLanguageCode: enrolled.source_language,
        });
        const picks = picked.flatMap((gloss) => {
          const rendering = pickRendering(askableRenderings(gloss, renderings), rng);
          return rendering ? [{ gloss_id: gloss.glossId, sense_id: rendering.senseId, variant_id: rendering.variantId }] : [];
        });
        if (picks.length === 0) throw new NoSavedWords(enrollmentId);
        // Phase 24 (spec D3): the rotation's step is how many list sessions came
        // before this one. Read before the insert, so it does not count itself.
        const ordinal = await session.countListSessions(enrollmentId);
        const sessionId = await session.insertPreparingSession(enrolled.user_id, enrollmentId);
        await jobs.enqueue(PREPARE_SESSION, {
          session_id: sessionId,
          picks,
          listening: options.listening,
          speaking: options.speaking,
          ordinal,
        });
        return { sessionId, status: 'preparing' as const, source: 'list' as const };
      }),

    /** Resume and the poll both read through this. A completed session also
     *  carries what it did to the saved words. */
    getSession: (actorUserId: string, sessionId: string): Promise<SessionResult> =>
      transaction(async (repos) => {
        await authorizeSession(repos, logger, actorUserId, sessionId);
        const record = await repos.session.loadSession(sessionId);
        if (!record) throw new SessionNotFound(sessionId);
        return { ...record, progress: await progressOf(repos, sessionId, record) };
      }),

    /** What the home screen needs in one read. */
    currentSession: (
      actorUserId: string,
      enrollmentId: string,
    ): Promise<{ current: SessionSummary | null; nextSource: SessionSource; savedCount: number }> =>
      transaction(async (repos) => {
        await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'session.practice' });
        const latest = await repos.session.findLatest(enrollmentId);
        return {
          current: latest && isCurrent(latest.status) ? latest : null,
          nextSource: nextSource(latest !== undefined),
          savedCount: await repos.vocabulary.countEntries(enrollmentId),
        };
      }),

    /**
     * Ends a preparing or ready session. Idempotent on `skipped`. A job still
     * generating for it finds the status changed at its final, conditional
     * write and writes nothing. A skip counts the answers given before it toward
     * progress.
     */
    skipSession: async (actorUserId: string, sessionId: string): Promise<void> => {
      const skipped = await transaction(async (repos) => {
        await authorizeSession(repos, logger, actorUserId, sessionId);
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
      actorUserId: string,
      sessionId: string,
      questionId: string,
      answer: AnswerInput,
    ): Promise<SessionResult> => {
      // The transaction returns its outcome and the log fires after it resolves:
      // a commit that fails after completeSession must not leave a log claiming a
      // session the database never recorded.
      const { result, justCompleted } = await transaction(async (repos) => {
        await authorizeSession(repos, logger, actorUserId, sessionId);
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
        // answerBySpeech judges before it gets here, with the same pure function.
        if (outcome.status === 'unheard') throw new Error('an unheard transcript reached submitAnswer');
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
          'option_index' in answer
            ? { displayIndex: answer.option_index }
            : { text: recorded.answer_string, verdict: recorded.verdict! },
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
     * Phase 25 (spec D5). One spoken attempt at the current card. The card is
     * checked first, so no model call is spent on a stale or wrong request; the
     * clip is transcribed outside any transaction (ADR 0001 R8); and an
     * understood answer is recorded through submitAnswer, exactly as a
     * next-step is. A transcript that is not the word writes nothing.
     * Another learner's session is refused before all of it (phase 29).
     */
    answerBySpeech: async (
      actorUserId: string,
      sessionId: string,
      input: { questionId: string; audio: string; mimeType: string },
    ): Promise<SpeechResult> => {
      type Checked = { replay: SpeechResult } | { current: SpeakingQuestion; language: LanguageCode };
      const checked = await transaction(async (repos): Promise<Checked> => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }
        // A retry of an attempt already recorded: the stored answer, no call.
        const last = loaded.answers[loaded.answers.length - 1];
        if (last && last.question_id === input.questionId) {
          // Ruling R1: only a recorded spoken answer is replayed; any other
          // answer to this card means this upload is stale.
          if (last.verdict !== 'understood' && last.verdict !== 'alternative') {
            throw new QuestionDesynced(input.questionId);
          }
          const progress = await progressOf(repos, sessionId, loaded);
          const replay: SpeechResult = {
            heard: last.answer_string,
            verdict: last.verdict === 'alternative' ? 'alternative' : 'understood',
            session: { ...loaded, progress },
          };
          return { replay };
        }
        const current = currentQuestion(loaded);
        if (!current || current.id !== input.questionId) throw new QuestionDesynced(input.questionId);
        if (!isSpeaking(current)) throw new AnswerKindMismatch(input.questionId);
        return { current, language: enrolled.target_language as LanguageCode };
      });
      if ('replay' in checked) return checked.replay;

      const started = now();
      let heard = '';
      if (input.audio.length >= MIN_AUDIO_CHARS) {
        try {
          const raw = await transcriber({
            system: transcriptionSystem(checked.language),
            audio: input.audio,
            mimeType: input.mimeType,
            schema: LlmTranscriptSchema,
          });
          const parsed = parseTranscript(raw);
          if (parsed === null) throw new LlmUnavailable('the transcript was unreadable');
          heard = parsed;
        } catch (error) {
          // The route maps this to a 502 and drops the cause; this is its trace.
          logger.info({
            event: 'speech_failed',
            session_id: sessionId,
            question_type: checked.current.type,
            transcribe_ms: now() - started,
            bytes: Math.floor((input.audio.length * 3) / 4),
            mime_type: input.mimeType,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
      const transcribed = input.audio.length >= MIN_AUDIO_CHARS;
      const transcribeMs = now() - started;

      const verdict = spokenVerdict(checked.current, heard);
      // Logged before the answer is recorded: it is the model's judgement, which
      // was paid for even when submitAnswer then throws on a desync race. A clip
      // too short for a call made none, so it has no wait to report.
      logger.info({
        event: 'speech_judged',
        session_id: sessionId,
        question_type: checked.current.type,
        verdict,
        heard,
        transcribed,
        ...(transcribed ? { transcribe_ms: transcribeMs } : {}),
        bytes: Math.floor((input.audio.length * 3) / 4),
        mime_type: input.mimeType,
      });
      const session =
        verdict === 'unheard' ? null : await service.submitAnswer(actorUserId, sessionId, input.questionId, { heard });
      return { heard, verdict, session };
    },

    /**
     * Phase 27 (spec D3). A text answer the server judges. The card is checked
     * first, so no model call is spent on a stale or wrong request; a rule
     * decides an empty answer, the stored meaning and (phase 31, spec D13) its
     * stored alternatives; otherwise the judge is called outside any
     * transaction (ADR 0001 R8); and the verdict is recorded through
     * submitAnswer, exactly as a next-step is. Another learner's session is
     * refused before all of it (phase 29).
     */
    answerJudged: async (
      actorUserId: string,
      sessionId: string,
      input: { questionId: string; text: string },
    ): Promise<JudgedResult> => {
      type Checked =
        | { replay: JudgedResult }
        | { current: JudgedQuestion; context: JudgeContext };
      const checked = await transaction(async (repos): Promise<Checked> => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }
        // A retry of an answer already recorded: the stored verdict, no call.
        // Only this endpoint answers a judged card, so any typed verdict is one.
        const last = loaded.answers[loaded.answers.length - 1];
        if (last && last.question_id === input.questionId) {
          const verdict = TypedVerdictSchema.safeParse(last.verdict);
          if (!verdict.success) throw new QuestionDesynced(input.questionId);
          return { replay: { verdict: verdict.data, session: { ...loaded, progress: await progressOf(repos, sessionId, loaded) } } };
        }
        const current = currentQuestion(loaded);
        if (!current || current.id !== input.questionId) throw new QuestionDesynced(input.questionId);
        if (!isJudged(current)) throw new AnswerKindMismatch(input.questionId);
        const found = await repos.question.findJudgeContext(current.id);
        if (!found) throw new SessionNotFound(sessionId);
        return { current, context: { language: enrolled.target_language as LanguageCode, explanation: enrolled.source_language as LanguageCode, ...found } };
      });
      if ('replay' in checked) return checked.replay;

      const text = input.text.slice(0, MAX_JUDGED_TEXT);
      let verdict = ruleVerdict(checked.current, text, checked.context.alternatives);
      const judgedBy = verdict === null ? 'model' : 'rule';
      const started = now();
      if (verdict === null) {
        try {
          const raw = await judge(judgePrompt(checked.current, checked.context, text));
          verdict = parseJudge(checked.current.type, raw);
          if (verdict === null) throw new LlmUnavailable('the verdict was unreadable');
        } catch (error) {
          logger.info({
            event: 'answer_judge_failed',
            session_id: sessionId,
            question_type: checked.current.type,
            judge_ms: now() - started,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
      // Logged before the answer is recorded: a paid call is always logged,
      // even when submitAnswer then throws on a desync race.
      logger.info({
        event: 'answer_judged',
        session_id: sessionId,
        question_type: checked.current.type,
        verdict,
        judged_by: judgedBy,
        ...(judgedBy === 'model' ? { judge_ms: now() - started } : {}),
        chars: text.length,
      });
      const session = await service.submitAnswer(actorUserId, sessionId, input.questionId, { text, judged: verdict });
      // Two overlapping requests may both have paid for a call; step replayed
      // the first, so report the verdict stored for this card, not our own.
      const stored = TypedVerdictSchema.safeParse(session.answers.find((a) => a.question_id === input.questionId)?.verdict);
      return { verdict: stored.success ? stored.data : verdict, session };
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

      const read = await transaction(async ({ session, enrollment, question, gloss, dict }) => {
        const state = await session.findState(sessionId);
        // Skipped, or gone (a reseed): nothing to prepare, and not a failure.
        if (!state || state.status !== 'preparing') return undefined;
        const enrolled = await enrollment.findById(state.enrollmentId);
        if (!enrolled) return undefined;
        // Phase 31 (spec D14). A pick made before a merge names the survivor now,
        // and a gloss of another learner language is refused.
        const resolved = await gloss.resolveGlosses(payload.picks.map((pick) => pick.gloss_id));
        const foreign = payload.picks.find(
          (pick) => (resolved.get(pick.gloss_id)?.userLanguageCode ?? enrolled.source_language) !== enrolled.source_language,
        );
        if (foreign) throw new GlossLanguageMismatch(foreign.gloss_id);
        const context = await question.findGenerationContext({
          picks: payload.picks.map((pick) => ({
            glossId: resolved.get(pick.gloss_id)?.id ?? pick.gloss_id,
            senseId: pick.sense_id,
            variantId: pick.variant_id,
          })),
          sourceLanguage: enrolled.source_language,
        });
        // Spec D5, D6: the sentences the last sessions asked, so a new one is never one of them.
        const recent = await question.findRecentSentences({
          enrollmentId: state.enrollmentId,
          glossIds: context.map((row) => row.glossId),
          limit: MAX_AVOID,
        });
        // Phase 31 (spec D18): the other headwords with each card's key.
        const siblings = await dict.findSiblings({ glossIds: context.map((row) => row.glossId) });
        return { state, enrolled, context, recent, siblings };
      });
      if (!read) {
        logger.info({ event: 'session_preparation_dropped', session_id: sessionId, stage: 'read' });
        return;
      }
      if (read.context.length === 0) {
        throw new InvalidDistractors(sessionId, 'none of the picked senses is in the dictionary any more');
      }

      // Phase 24 (spec D3, D4). The plan decides each position's type and the
      // order of the picks, before the model is asked anything.
      const target = read.enrolled.target_language as LanguageCode;
      const plan = planSession(
        read.context.map((row) => ({
          form: row.form,
          translation: row.translation,
          tiles: tileEligible(row.form),
          speakable: speakable(row.form),
          // Spec D7: a cloze choice needs the form, or its lemma, once in the saved example.
          clozeGap: row.exampleTranslation !== null && findGap(row.example ?? '', [row.form, row.lemma]) !== null,
        })),
        { listening: payload.listening, speaking: payload.speaking, ordinal: payload.ordinal },
      );
      const ordered = plan.order.map((index) => read.context[index]);
      const tasks = tasksFor(plan);
      const items = distractorItems(ordered, tasks, read.recent);
      // Phase 31 (spec D18). Another headword with this card's key is right where
      // the card asks for this one: off limits as a wrong option, and named to the
      // model with the session's other rows, so it never offers one the
      // validator would refuse on every retry.
      const siblingsOf = (glossId: string) =>
        read.siblings.filter((sibling) => sibling.glossId === glossId).map((sibling) => sibling.lemma);
      const siblingRows = ordered.flatMap((row) => siblingsOf(row.glossId).map((lemma) => ({ form: lemma, translation: row.translation })));
      // The rows that ask the model nothing are still in the session: the
      // validation and the prompt must know their words and meanings.
      const others = [...ordered.filter((_, index) => !tasks[index]), ...siblingRows];
      // Where each pick's form sits in its saved example: the same search that
      // made the gap item's blank and the plan's eligibility.
      const gaps = ordered.map((row) => findGap(row.example ?? '', [row.form, row.lemma]));

      const started = now();
      let modelMs = 0;
      let verdict: Extract<DistractorVerdict, { ok: true }>;
      let meanings: string[] | null;
      const board = plan.board;
      try {
        const raw = await llm(
          buildDistractorPrompt({ items, from: target, to: read.enrolled.source_language, others }),
        );
        modelMs = now() - started;
        // An empty string is the provider's "no content" (a safety block). Here,
        // unlike a lookup, there is nothing useful to serve without it.
        const answer = raw === '' ? null : parseLlmDistractors(raw);
        if (!answer) throw new InvalidDistractors(sessionId, 'the model answer was unreadable');
        const checked = validateDistractors(items, answer, read.enrolled.source_language, others, target);
        if (!checked.ok) throw new InvalidDistractors(sessionId, checked.reason);
        verdict = checked;

        // Spec D10: the board's fifth meaning is its first word's first wrong
        // meaning that is none of the four, nor another saved meaning of one
        // of its words.
        meanings = board
          ? boardMeanings(
              ordered.slice(board.start, board.start + BOARD_SIZE),
              ordered,
              verdict.byKey.get(keyOf(board.start))!.distractors,
            )
          : null;
        if (board && !meanings) {
          throw new InvalidDistractors(sessionId, "every wrong meaning of the board is one of its words' own");
        }
      } catch (error) {
        // Spec D16: a failed attempt is a measurement too, not only the
        // dead-letter fifteen minutes on.
        logger.info({
          event: 'session_preparation_attempt_failed',
          session_id: sessionId,
          item_count: items.length,
          model_ms: now() - started,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Logged once the session is written, not on an attempt a failed insert or a retry repeats.
      let degradedEvents: Record<string, unknown>[] = [];
      const written = await transaction(async ({ session, question, gloss }) => {
        degradedEvents = [];
        // Conditional: a skip that landed during the model call wins, and this
        // transaction then writes nothing at all.
        if (!(await session.transition(sessionId, ['preparing'], 'ready'))) return false;
        // Phase 31 (spec D14). Again, under this write's own share lock: a merge
        // may have landed during the model call.
        const survivors = await gloss.resolveGlosses(ordered.map((row) => row.glossId));
        const generated = await question.insertGeneratedQuestions({
          userId: read.state.userId,
          enrollmentId: read.state.enrollmentId,
          targetLanguage: target,
          userLanguageCode: read.enrolled.source_language,
          questions: ordered.map((row, index) => {
            const made = verdict.byKey.get(keyOf(index)) ?? NOTHING_GENERATED;
            // Spec D5, D6: a sentence card the model did not make usable is a
            // typed translation, with nothing generated for it.
            const planned = plan.types[index];
            const degraded =
              (planned === 'cloze_typed' && !made.sentence) || (planned === 'sentence_translation' && !made.translate);
            if (degraded) {
              degradedEvents.push({
                event: 'sentence_degraded',
                session_id: sessionId,
                position: index,
                type: planned,
                reason: made.degraded,
              });
            }
            const type = degraded ? 'typed_translation' : planned;
            const content = degraded ? NOTHING_GENERATED : made;
            // Spec D18. A sibling headword is a right answer to a typed or spoken card.
            const answered =
              type === 'typed_translation' || type === 'say_translation'
                ? {
                    ...content,
                    alternatives: withSiblingAlternatives({
                      form: row.form,
                      lemma: row.lemma,
                      siblings: siblingsOf(row.glossId),
                      alternatives: content.alternatives,
                    }),
                  }
                : content;
            return {
              glossId: survivors.get(row.glossId)?.id ?? row.glossId,
              variantId: row.variantId,
              form: row.form,
              lemma: row.lemma,
              partOfSpeech: row.partOfSpeech,
              lexemeId: row.lexemeId,
              type,
              ...generatedContent(row, type, answered, {
                tiles: type === 'letter_tiles' ? tilesFor(row.form, LANGUAGES[target].alphabet, rng) : null,
                board: type === 'matching' && board && meanings ? { meanings, own: index - board.start } : null,
                gap: gaps[index],
              }),
            };
          }),
        });
        // Each choice shuffled on its own, a board's words once together; the
        // question order is the plan's and is not shuffled.
        await session.insertSessionQuestions(sessionId, shuffleSession(generated, rng));
        return true;
      });

      if (written) for (const event of degradedEvents) logger.info(event);
      logger.info({
        event: written ? 'session_prepared' : 'session_preparation_dropped',
        session_id: sessionId,
        question_count: written ? read.context.length : 0,
        item_count: items.length,
        model_ms: modelMs,
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
  return service;
}

export type SessionService = ReturnType<typeof createSessionService>;

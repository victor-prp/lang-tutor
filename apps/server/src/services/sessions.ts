import type { AnswerRecord, Enrollment, SessionSource, SessionStatus, SpeechVerdict, TypedVerdict } from '@lang-tutor/core/api';
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
  type QuestionType,
  type SpeakingQuestion,
} from '@lang-tutor/core/domain';

import { usableAnswerForm } from '../domain/answerForm';
import {
  buildCheckPrompt,
  contextKeyOf,
  meaningFits,
  parseCheck,
  readCheck,
  readingCandidates,
  translationUses,
  wordsFit,
  wrongOnly,
  type CheckFinding,
  type CheckItem,
} from '../domain/check';
import { chooseWords, liveDimensions } from '../domain/choose';
import { findGap } from '../domain/cloze';
import {
  buildContextPrompt,
  contextColumns,
  contextItemFor,
  contextLanguageOf,
  fallbackContext,
  markFor,
  parseLlmContext,
  resolveContext,
  type BareContextItem,
  type ContextItem,
  type StoredContext,
} from '../domain/context';
import {
  ASKED_DISTRACTORS,
  KEPT_DISTRACTORS,
  NOTHING_GENERATED,
  boardMeanings,
  buildDistractorPrompt,
  distractorItems,
  generatedContent,
  keyOf,
  knownMeanings,
  parseLlmDistractors,
  tasksFor,
  validateDistractors,
  withSiblingAlternatives,
  type DistractorVerdict,
  type GenerationContext,
  type Generated,
} from '../domain/distractors';
import { glossFamilies } from '../domain/glossFamilies';
import { familyChanges, isEmptyFamilyWrite } from '../domain/glossFamilyRecord';
import { judgePrompt, parseJudge, ruleVerdict, type JudgeContext } from '../domain/judge';
import { ACCEPT_RENDERING, PREPARE_SESSION, PrepareSessionPayloadSchema, acceptRenderingKey } from '../domain/jobs';
import { LANGUAGES, type LanguageCode } from '../domain/languages';
import { BOARD_SIZE, planCards } from '../domain/plan';
import { dayState } from '../domain/today';
import { applySession } from '../domain/memoryUpdate';
import { evaluateSession, progressChanges, type ProgressChange } from '../domain/progress';
import type { SessionRecord, SessionSummary } from '../domain/session';
import {
  SESSION_LENGTH,
  askableRenderings,
  attemptOf,
  isCurrent,
  isOpen,
  newSessionRecord,
  nextSource,
  pickRendering,
  sessionScore,
  step,
} from '../domain/session';
import { MAX_AVOID } from '../domain/sentences';
import type { Mark } from '../domain/marks';
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
import { learnerDay } from './learnerDay';
import type { LlmClient } from './llm';
import type { SpeechTranscriber } from './speech';
import type { Repos, Transaction } from './transaction';

export type { Transaction } from './transaction';

/** Phase 34 (spec D4, D5). The cards that show wrong options, three of them. */
const CHOSEN: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'listen_choice', 'reverse_choice', 'cloze_choice']);

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

  // Phase 35 (spec D4). The same answers, as memory. `rows` exist only for saved
  // glosses, so an answer about an unsaved one counts for nothing here too.
  const saved = new Set(rows.map((row) => row.glossId));
  const before = await repos.memory.findRows({ enrollmentId: evidence.enrollmentId, glossIds: [...saved] });
  const memory = applySession(
    before,
    evidence.answers.filter((answer) => saved.has(answer.glossId)),
    evidence.day,
  );
  await repos.memory.upsertRows({ enrollmentId: evidence.enrollmentId, rows: memory });
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

/**
 * Phase 34 (spec D9). The verdict a judged answer was answered with: its first
 * answer's, or its retry's. A retry given up was an empty text, which a judged
 * card answers `wrong`, as on a first answer; it is stored as `gave_up`. Null
 * when the stored answer is not one this route gave.
 */
function judgedVerdictOf(answer: AnswerRecord, of: 'answer' | 'retry'): TypedVerdict | null {
  const stored = of === 'retry' ? answer.retry_verdict : answer.verdict;
  if (of === 'retry' && stored === 'gave_up') return 'wrong';
  const parsed = TypedVerdictSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
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
  contextLlm,
  checkerLlm,
  transcriber,
  judge,
}: {
  transaction: Transaction;
  rng: () => number;
  now: () => number;
  logger: Logger;
  llm: LlmClient;
  /** Phase 34 (ruling R12). The context call's client: the batch's provider
   *  with a short budget of its own, so a hang costs the sentences only. */
  contextLlm: LlmClient;
  /** Phase 34 (spec D5, ruling R12). The checker's client, likewise with a
   *  budget of its own; its failure fails the attempt, which pg-boss retries. */
  checkerLlm: LlmClient;
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
        // Phase 35 (spec D5, D10). The words, each with a dimension and a rung,
        // from what the learner knows: memory and levels, on the owner's day,
        // with what that day already asked and introduced. At most one gloss per
        // key, across headwords (phase 31 D18), is chooseWords' rule now.
        const glossIds = saved.map((gloss) => gloss.glossId);
        const at = now();
        const today = await learnerDay(repos, enrolled.user_id, at);
        const memory = await repos.memory.findRows({ enrollmentId, glossIds });
        const levels = await repos.progress.findRows({ enrollmentId, glossIds, savedBy: null });
        // Phase 39 (spec D4, D5). The families, derived from the dictionary and
        // memory with the session's live skills. Only known_at is read from the
        // stored families: known once, known for the family (D2).
        const forms = await dict.findLexemeForms({ lexemeIds: [...new Set(saved.map((gloss) => gloss.lexemeId))] });
        const formsOf = new Map<string, string[]>();
        for (const row of forms) formsOf.set(row.lexemeId, [...(formsOf.get(row.lexemeId) ?? []), row.form]);
        const stored = await repos.glossFamilies.load(enrollmentId);
        const knownAt = new Map(stored.flatMap((family) => family.members.map((member) => [member.glossId, member.knownAt])));
        const families = glossFamilies({
          saved: saved.map((gloss) => ({
            glossId: gloss.glossId,
            lexemeId: gloss.lexemeId,
            lemma: gloss.lemma,
            key: gloss.key,
            savedAt: gloss.savedAt,
            forms: formsOf.get(gloss.lexemeId) ?? [],
            order: gloss.order,
            speakable: speakable(gloss.form),
            knownAt: knownAt.get(gloss.glossId) ?? null,
          })),
          memory,
          live: liveDimensions(options.listening, options.speaking),
        });
        const waiting = new Set([...families.state].filter(([, state]) => state === 'waiting').map(([glossId]) => glossId));
        // Phase 37 (spec D1, D7). Today's answers leave the returns owed and the
        // words done for the day.
        const introduced = await session.findIntroducedOn(enrollmentId, today);
        const { steps, done } = dayState(await session.findAnswersOn(enrollmentId, today), new Set(introduced));
        const chosen = chooseWords({
          saved,
          memory,
          levels,
          today,
          steps,
          done,
          newToday: introduced.length,
          listening: options.listening,
          speaking: options.speaking,
          rng,
          families: { familyOf: families.familyOf, waiting },
        });
        // Spec D12. One rendering per gloss, uniformly over every form of every
        // member that agrees with the gloss, the saved form always among them.
        // No model call: a lemma form not yet rendered joins once its job lands.
        const renderings = await dict.findGlossRenderings({
          glossIds: chosen.map((choice) => choice.glossId),
          userLanguageCode: enrolled.source_language,
        });
        const savedById = new Map(saved.map((gloss) => [gloss.glossId, gloss]));
        const picks = chosen.flatMap((choice) => {
          const rendering = pickRendering(askableRenderings(savedById.get(choice.glossId)!, renderings), rng);
          if (!rendering) return [];
          const { dimension, rung, level, r } = choice;
          const step = choice.cls === 'STEP';
          // Phase 39 (spec D6). A family's next meaning, never asked, is introduced with the known ones.
          const knownMeanings = families.introductions.get(choice.glossId);
          return [
            {
              gloss_id: choice.glossId,
              sense_id: rendering.senseId,
              variant_id: rendering.variantId,
              dimension,
              rung,
              level,
              r,
              step,
              ...(knownMeanings ? { known_meanings: knownMeanings } : {}),
            },
          ];
        });
        if (picks.length === 0) throw new NoSavedWords(enrollmentId);
        const sessionId = await session.insertPreparingSession(enrolled.user_id, enrollmentId);
        // Phase 39 (spec D4). The refresh is recorded once the session exists, so
        // each event names it; one that changed nothing writes nothing.
        const write = familyChanges(stored, families, new Date(at).toISOString());
        if (!isEmptyFamilyWrite(write)) await repos.glossFamilies.apply(enrollmentId, sessionId, write);
        await jobs.enqueue(PREPARE_SESSION, {
          session_id: sessionId,
          picks,
          listening: options.listening,
          speaking: options.speaking,
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
     * progress. Phase 34 (spec D9): a card held for its second try is given up
     * first, as "show the answer" would, so the skip writes progress as before.
     */
    skipSession: async (actorUserId: string, sessionId: string): Promise<void> => {
      const skipped = await transaction(async (repos) => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const state = await repos.session.findState(sessionId);
        if (!state) throw new SessionNotFound(sessionId);
        if (state.status === 'skipped') return false;
        if (!isOpen(state.status)) throw new SessionNotSkippable(sessionId, state.status);
        const day = await learnerDay(repos, enrolled.user_id, now());
        const changed = await repos.session.transition(sessionId, ['preparing', 'ready'], 'skipped', day);
        // Phase 20. The answers given before the skip are real answers.
        if (changed) {
          await repos.session.resolvePendingRetry(sessionId, { text: '', verdict: 'gave_up' });
          await recordProgress(repos, sessionId);
        }
        return changed;
      });
      if (skipped) logger.info({ event: 'session_skipped', session_id: sessionId });
    },

    /** `answer` is an option index for a choice and the typed text for a
     *  typed card (phase 23). A typed answer is judged here, by the same
     *  judgeTyped the app ran for its feedback, and stored with its verdict.
     *  Phase 34 (spec D9): `retry` is the second try at a card held for one. */
    submitAnswer: async (
      actorUserId: string,
      sessionId: string,
      questionId: string,
      answer: AnswerInput,
      { retry = false, hintOpened }: { retry?: boolean; hintOpened?: boolean } = {},
    ): Promise<SessionResult> => {
      // The transaction returns its outcome and the log fires after it resolves:
      // a commit that fails after completeSession must not leave a log claiming a
      // session the database never recorded.
      const { result, justCompleted } = await transaction(async (repos) => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);

        // Phase 19. Preparing, skipped and failed sessions take no answers. A
        // completed one still reaches `step`, whose replay path answers a retry.
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }

        // Four failure modes, four domain outcomes, four errors — the domain
        // decides what is wrong, this layer only names it.
        const outcome = step(loaded, questionId, answer, { retry });
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

        // Phase 34 (spec D9). A retry resolves the pending answer in its place; a
        // first answer is a new row, held for its second try when it opens one.
        // Either may complete the session: the last card's answer only when it
        // opens none, since a pending answer never completes one.
        if (outcome.recorded === 'retry') {
          const position = loaded.answers.length - 1;
          const resolved = outcome.record.answers[position];
          await repos.session.resolveRetry(sessionId, position, { text: resolved.retry_answer_string!, verdict: resolved.retry_verdict! });
        } else {
          const recorded = outcome.record.answers[loaded.answers.length];
          // Phase 38 (spec D4): only the card that has a hint records whether it was opened.
          const hinted = loaded.questions[loaded.answers.length].type === 'cloze_typed' ? { hintOpened: hintOpened ?? null } : {};
          await repos.session.insertAnswer(
            sessionId,
            loaded.answers.length,
            questionId,
            'option_index' in answer
              ? { displayIndex: answer.option_index }
              : {
                  text: recorded.answer_string,
                  verdict: recorded.verdict!,
                  ...(recorded.retry_state === 'pending' ? { pending: true as const } : {}),
                  ...hinted,
                },
          );
        }

        if (outcome.justCompleted) {
          await repos.session.completeSession(sessionId, await learnerDay(repos, enrolled.user_id, now()));
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
     *
     * Phase 34 (spec D9). A clip with `retry` at a card held for its second
     * try is the retry, transcribed and judged as the first clip was. Without
     * it, a clip there replays the first answer, pending, as a network retry of
     * the first clip must. So the model is called at most twice per card.
     */
    answerBySpeech: async (
      actorUserId: string,
      sessionId: string,
      input: { questionId: string; audio: string; mimeType: string; retry?: boolean },
    ): Promise<SpeechResult> => {
      const retry = input.retry ?? false;
      type Checked = { replay: SpeechResult } | { current: SpeakingQuestion; language: LanguageCode };
      const checked = await transaction(async (repos): Promise<Checked> => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }
        const attempt = attemptOf(loaded, input.questionId, retry);
        if (attempt.kind === 'desync') throw new QuestionDesynced(input.questionId);
        // An attempt already recorded: the stored answer, or its retry, no call.
        if (attempt.kind === 'replay') {
          const { answer, of } = attempt;
          const verdict = of === 'retry' ? answer.retry_verdict : answer.verdict;
          // Ruling R1: only a recorded spoken answer is replayed; any other
          // answer to this card means this upload is stale.
          if (verdict !== 'understood' && verdict !== 'alternative') {
            throw new QuestionDesynced(input.questionId);
          }
          const progress = await progressOf(repos, sessionId, loaded);
          const replay: SpeechResult = {
            heard: (of === 'retry' ? answer.retry_answer_string : answer.answer_string) ?? '',
            verdict,
            session: { ...loaded, progress },
          };
          return { replay };
        }
        if (!isSpeaking(attempt.question)) throw new AnswerKindMismatch(input.questionId);
        return { current: attempt.question, language: enrolled.target_language as LanguageCode };
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
        // Phase 34 (spec D9): a second try's call, the one more a card may cost.
        ...(retry ? { retry: true } : {}),
      });
      const session =
        verdict === 'unheard' ? null : await service.submitAnswer(actorUserId, sessionId, input.questionId, { heard }, { retry });
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
     *
     * Phase 34 (spec D9). A text with `retry` at a card held for its second try
     * is the retry, judged as the first answer was; an empty one gives up, by
     * rule. Without it, a text there replays the first answer, pending. So the
     * judge is called at most twice per card.
     */
    answerJudged: async (
      actorUserId: string,
      sessionId: string,
      input: { questionId: string; text: string; retry?: boolean },
    ): Promise<JudgedResult> => {
      const retry = input.retry ?? false;
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
        const attempt = attemptOf(loaded, input.questionId, retry);
        if (attempt.kind === 'desync') throw new QuestionDesynced(input.questionId);
        // An answer already recorded, or its retry: the stored verdict, no call.
        // Only this endpoint answers a judged card, so any typed verdict is one.
        if (attempt.kind === 'replay') {
          const verdict = judgedVerdictOf(attempt.answer, attempt.of);
          if (verdict === null) throw new QuestionDesynced(input.questionId);
          return { replay: { verdict, session: { ...loaded, progress: await progressOf(repos, sessionId, loaded) } } };
        }
        const current = attempt.question;
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
        // Phase 34 (spec D9): a second try's verdict, the one more a card may cost.
        ...(retry ? { retry: true } : {}),
      });
      const session = await service.submitAnswer(actorUserId, sessionId, input.questionId, { text, judged: verdict }, { retry });
      // Two overlapping requests may both have paid for a call; step replayed
      // the first, so report the verdict stored for this card, not our own.
      const stored = session.answers.find((a) => a.question_id === input.questionId);
      return { verdict: (stored && judgedVerdictOf(stored, retry ? 'retry' : 'answer')) ?? verdict, session };
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

      const read = await transaction(async ({ session, enrollment, question, gloss, dict, jobs }) => {
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
        const asked = payload.picks.map((pick) => ({
          glossId: resolved.get(pick.gloss_id)?.id ?? pick.gloss_id,
          senseId: pick.sense_id,
          variantId: pick.variant_id,
          pick,
        }));
        const context = await question.findGenerationContext({
          picks: asked.map(({ glossId, senseId, variantId }) => ({ glossId, senseId, variantId })),
          sourceLanguage: enrolled.source_language,
        });
        // Phase 34 (spec D1). A picked rendering the accept job never ran for is
        // asked for now, in the transaction of the read that found it (ADR
        // 0007). Its card falls back on this session's own alternatives; the
        // next session has the list. The stamp decides, not the list: a
        // rendering the job found nothing for is stamped and never asked again.
        // The queue keeps one job per rendering, so a retry of this job or a
        // burst of sessions pays for one call. In key order (ruling R7): two
        // concurrent transactions that share renderings then take the queue's
        // unique key in the same order, and neither waits on the other's second.
        const accepts = context
          .filter((row) => row.acceptedAt === null)
          .map((row) => {
            const payload = { variant_id: row.variantId, sense_id: row.senseId, user_language_code: enrolled.source_language };
            return { payload, singletonKey: acceptRenderingKey(payload) };
          })
          .sort((a, b) => (a.singletonKey < b.singletonKey ? -1 : a.singletonKey > b.singletonKey ? 1 : 0));
        for (const { payload, singletonKey } of accepts) {
          await jobs.enqueue(ACCEPT_RENDERING, payload, { singletonKey });
        }
        // Each row's pick. The rows come in the picks' order, a pick whose
        // rendering is gone having none, and name the rendering asked for.
        let next = 0;
        const pickOf = (row: GenerationContext) => {
          const at = asked.findIndex((a, i) => i >= next && a.senseId === row.senseId && a.variantId === row.variantId);
          if (at < 0) throw new Error(`no pick asked for the rendering ${row.senseId}/${row.variantId}`);
          next = at + 1;
          return asked[at].pick;
        };
        // Spec D5, D6: the sentences the last sessions asked, so a new one is never one of them.
        const recent = await question.findRecentSentences({
          enrollmentId: state.enrollmentId,
          glossIds: context.map((row) => row.glossId),
          limit: MAX_AVOID,
        });
        // Phase 34 (spec D6): the context sentences the last sessions showed, likewise.
        const recentContexts = await question.findRecentContexts({
          enrollmentId: state.enrollmentId,
          glossIds: context.map((row) => row.glossId),
          limit: MAX_AVOID,
        });
        // Phase 31 (spec D18): the other headwords with each card's key.
        const siblings = await dict.findSiblings({ glossIds: context.map((row) => row.glossId) });
        // Phase 34 (spec D2, ruling R6). A stored answer form is a model's word:
        // a card asks for it only when it is plausibly a form of its own word,
        // and as the card will show it. Everything below reads this one value.
        const formed = context.map((row) => ({ ...row, answerForm: usableAnswerForm(row.answerForm, row.form, row.lemma) }));
        // Phase 34 (spec D3). What the dictionary already knows to be right for
        // these picks, read once: no wrong option, no board's fifth meaning and no
        // pair of board words may be one of them.
        const unique = (values: string[]) => [...new Set(values)];
        const known = await dict.findKnownRight({
          glossIds: unique(formed.map((row) => row.glossId)),
          lexemeIds: unique(formed.map((row) => row.lexemeId)),
          variantIds: unique(formed.map((row) => row.variantId)),
          prompts: unique(formed.map((row) => row.translation)),
          userLanguageCode: enrolled.source_language,
          targetLanguage: enrolled.target_language,
        });
        return { state, enrolled, context: formed, picked: context.map(pickOf), recent, recentContexts, siblings, known };
      });
      if (!read) {
        logger.info({ event: 'session_preparation_dropped', session_id: sessionId, stage: 'read' });
        return;
      }
      if (read.context.length === 0) {
        throw new InvalidDistractors(sessionId, 'none of the picked senses is in the dictionary any more');
      }

      // Phase 35 (spec D6). The plan chooses each pick's card from its dimension,
      // rung, level and R, and the order of the picks, before the model is asked
      // anything.
      const target = read.enrolled.target_language as LanguageCode;
      const plan = planCards(
        read.context.map((row, index) => {
          const { dimension, rung, level, r, step } = read.picked[index];
          return {
            form: row.form,
            translation: row.translation,
            // Phase 34 (spec D2): tiles build the form the card asks for.
            tiles: tileEligible(row.answerForm ?? row.form),
            // read_aloud and the sentence cards use the saved form, say_translation the asked one.
            speakable: speakable(row.form) && speakable(row.answerForm ?? row.form),
            // Phase 27 (spec D7): a cloze choice needs the form, or its lemma, once in the saved example.
            clozeGap: row.exampleTranslation !== null && findGap(row.example ?? '', [row.form, row.lemma]) !== null,
            // Phase 34 (spec D3): no board word's meaning is one the dictionary knows for another.
            meanings: knownMeanings(read.known, row.lexemeId),
            dimension,
            rung,
            level,
            r,
            step,
          };
        }),
        { listening: payload.listening, speaking: payload.speaking },
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
        // Phase 34 (spec D3, D4): the first three usable of six, none known right.
        const checked = validateDistractors(items, answer, read.enrolled.source_language, others, target, read.known);
        if (!checked.ok) throw new InvalidDistractors(sessionId, checked.reason);
        verdict = checked;
        // Spec D10: a board with no usable fifth meaning fails here, before the
        // context call and the checker are paid for; the checker can only take
        // more away (below).
        const first = board ? verdict.byKey.get(keyOf(board.start)) : undefined;
        if (board && !boardMeanings(ordered.slice(board.start, board.start + BOARD_SIZE), ordered, [...first!.distractors, ...first!.spares], read.known)) {
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

      // Spec D18, phase 34 (spec D1). A typed or spoken card accepts the
      // rendering's stored list, a sibling headword, and this session's own
      // alternatives, none written back. A typed cloze is judged against the
      // form its sentence needs, so it keeps its sentence's alternatives alone.
      const typedAnswered = (row: GenerationContext, content: Generated): Generated => ({
        ...content,
        alternatives: withSiblingAlternatives({
          form: row.answerForm ?? row.form,
          lemma: row.lemma,
          accepted: row.acceptedAnswers,
          siblings: siblingsOf(row.glossId),
          alternatives: content.alternatives,
        }),
      });
      // Spec D5, D6 (phase 27): a sentence card the model did not make usable is
      // a typed translation, with nothing generated for it. Decided before the
      // context call, which asks each card by the type it ends up with.
      const cards = ordered.map((row, index) => {
        const made = verdict.byKey.get(keyOf(index)) ?? NOTHING_GENERATED;
        const planned = plan.types[index];
        const degraded =
          (planned === 'cloze_typed' && !made.sentence) || (planned === 'sentence_translation' && !made.translate);
        const type = degraded ? 'typed_translation' : planned;
        const content = degraded ? NOTHING_GENERATED : made;
        const answered: Generated = type === 'typed_translation' || type === 'say_translation' ? typedAnswered(row, content) : content;
        return { row, index, planned, type, answered, degradedReason: degraded ? (made.degraded ?? 'no sentence') : null };
      });

      // Phase 34 (spec D6, D7, D8; rulings R8, R11). One more call, after the
      // batch's answer is validated (a sentence card's mark needs its Hebrew)
      // and with no transaction open (ADR 0001 R8): the sentence each bare-word
      // card shows, and the practised word in each sentence card's Hebrew. It
      // never fails the session: without its answer every card falls back on
      // its saved example, unmarked, and a sentence card is unmarked.
      const sentenceOf = (answered: Generated) => {
        if (answered.sentence) {
          const { sentence, translation, gap } = answered.sentence;
          return { hebrew: translation, target: sentence, word: sentence.slice(gap.start, gap.end) };
        }
        if (answered.translate) {
          const { hebrew, reference, gap } = answered.translate;
          return { hebrew, target: reference, word: reference.slice(gap.start, gap.end) };
        }
        return null;
      };
      const contextItems = new Map<number, ContextItem>();
      for (const card of cards) {
        const item = contextItemFor({
          key: keyOf(card.index),
          type: card.type,
          row: card.row,
          alternatives: card.answered.alternatives,
          recent: read.recentContexts.get(card.row.glossId)?.[card.type] ?? [],
          sentence: sentenceOf(card.answered),
        });
        if (item) contextItems.set(card.index, item);
      }
      let contextMs = 0;
      let contextAnswer: ReturnType<typeof parseLlmContext> = null;
      if (contextItems.size > 0) {
        const contextStarted = now();
        let failure: string | null = null;
        try {
          const raw = await contextLlm(
            buildContextPrompt({ items: [...contextItems.values()], from: target, to: read.enrolled.source_language }),
          );
          contextAnswer = raw === '' ? null : parseLlmContext(raw);
          if (!contextAnswer) failure = raw === '' ? 'the model returned no content' : 'the context answer was unreadable';
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        contextMs = now() - contextStarted;
        // Logged where it happens: the call was paid for, and the session goes on without it.
        if (failure) {
          logger.info({
            event: 'context_call_failed',
            session_id: sessionId,
            item_count: contextItems.size,
            context_ms: contextMs,
            reason: failure,
          });
        }
      }
      const found = new Map((contextAnswer?.items ?? []).map((item) => [item.key, item]));
      const languages = { target, explanation: read.enrolled.source_language as LanguageCode };

      // Logged once the session is written, not on an attempt a failed insert or a retry repeats.
      const events: Record<string, unknown>[] = [];
      const shown = cards.map((card) => {
        const item = contextItems.get(card.index);
        let context: StoredContext | null = null;
        // Phase 34 (spec D5): only a sentence the model wrote is the checker's to read.
        let checkable: BareContextItem | null = null;
        let sentence: { text: string; mark: Mark | null } | null = null;
        if (item?.task === 'mark') {
          sentence = { text: item.sentence, mark: contextAnswer ? markFor(item, found.get(item.key)) : null };
        } else if (item) {
          if (contextAnswer) {
            const outcome = resolveContext(item, found.get(item.key), languages);
            context = outcome.context;
            if (outcome.dropped) {
              events.push({ event: 'context_dropped', session_id: sessionId, position: card.index, type: card.type, reason: outcome.dropped });
            } else {
              checkable = item;
            }
          } else {
            context = fallbackContext(card.row, item.task);
          }
        }
        return { ...card, context, checkable, sentence };
      });

      // Phase 34 (spec D5). The checker: a second model reads the cards as a
      // learner would, with no transaction open (ADR 0001 R8). Every usable
      // wrong option of a choice card, spares included, so a "yes" can be
      // replaced; the board's candidates for its fifth meaning against each of
      // its four words; each sentence the context call wrote; each sentence
      // card's Hebrew. Unlike the context call, an unreadable or failed answer
      // fails the attempt, as an unreadable batch does, and pg-boss retries it.
      // At most six (ASKED_DISTRACTORS), as validateDistractors keeps them: the
      // checker numbers every option, and a miscount fails the attempt.
      const candidatesOf = (index: number): string[] => {
        const made = verdict.byKey.get(keyOf(index));
        return made ? [...made.distractors, ...made.spares].slice(0, ASKED_DISTRACTORS) : [];
      };
      const boardCandidates = board ? candidatesOf(board.start) : [];
      const glossMeanings = (row: GenerationContext) => [row.translation, ...(read.known.meaningsByGloss.get(row.glossId) ?? [])];
      const checkItems: CheckItem[] = [];
      for (const card of shown) {
        const key = keyOf(card.index);
        const { row } = card;
        if (card.type === 'multiple_choice' || card.type === 'listen_choice') {
          checkItems.push({ key, task: 'choice', word: row.answerForm ?? row.form, options: candidatesOf(card.index) });
        } else if (card.type === 'reverse_choice') {
          checkItems.push({ key, task: 'choice', word: row.translation, options: candidatesOf(card.index) });
        } else if (card.type === 'cloze_choice') {
          const gap = gaps[card.index]!;
          const sentence = `${row.example!.slice(0, gap.start)}___${row.example!.slice(gap.end)}`;
          checkItems.push({ key, task: 'gap', sentence, options: candidatesOf(card.index) });
        } else if (card.type === 'matching' && boardCandidates.length > 0) {
          checkItems.push({ key, task: 'choice', word: row.form, options: boardCandidates });
        }
        if (card.checkable && card.context) {
          const { text, mark } = card.context;
          const marked = mark ? text.slice(mark.start, mark.end) : card.checkable.shown;
          checkItems.push(
            card.checkable.task === 'target'
              ? {
                  key: contextKeyOf(key),
                  task: 'meaning',
                  sentence: text,
                  word: marked,
                  candidates: readingCandidates([...glossMeanings(row), ...knownMeanings(read.known, row.lexemeId)]),
                }
              : { key: contextKeyOf(key), task: 'words', sentence: text, word: marked },
          );
        }
        const hebrew = sentenceOf(card.answered)?.hebrew;
        if ((card.type === 'cloze_typed' || card.type === 'sentence_translation') && hebrew) {
          checkItems.push({ key, task: 'translate', sentence: hebrew });
        }
      }

      const checkerStarted = now();
      let checkerMs = 0;
      let findings = new Map<string, CheckFinding>();
      let meanings: string[] | null = null;
      const survivors = new Map<number, string[]>();
      try {
        if (checkItems.length > 0) {
          const raw = await checkerLlm(buildCheckPrompt(checkItems, target, read.enrolled.source_language));
          checkerMs = now() - checkerStarted;
          const answer = raw === '' ? null : parseCheck(raw);
          if (!answer) {
            throw new InvalidDistractors(sessionId, raw === '' ? 'the checker returned no content' : 'the checker answer was unreadable');
          }
          const reading = readCheck(checkItems, answer);
          if (!reading.ok) throw new InvalidDistractors(sessionId, reading.reason);
          findings = reading.byKey;
        }
        const alsoRight = (key: string): boolean[] => {
          const finding = findings.get(key);
          return finding && (finding.task === 'choice' || finding.task === 'gap') ? finding.alsoRight : [];
        };
        // Spec D4: a "yes" drops the option and the next spare takes its place;
        // fewer than three left fails the attempt, as fewer than three usable does.
        for (const card of shown) {
          if (!CHOSEN.has(card.type)) continue;
          const key = keyOf(card.index);
          const left = wrongOnly(candidatesOf(card.index), alsoRight(key));
          if (left.length < KEPT_DISTRACTORS) {
            throw new InvalidDistractors(
              sessionId,
              `the checker calls ${candidatesOf(card.index).length - left.length} of ${key}'s ${candidatesOf(card.index).length} wrong options right, and ${KEPT_DISTRACTORS} must be left`,
            );
          }
          survivors.set(card.index, left);
        }
        // Spec D10, phase 34 (D3, D5): the board's fifth meaning is the first of its
        // first word's usable wrong meanings that no board word's own meaning, nor
        // what the dictionary knows of the four, nor the checker for any of them,
        // makes right.
        if (board) {
          const rightForOne = new Set(
            Array.from({ length: BOARD_SIZE }, (_, offset) => alsoRight(keyOf(board.start + offset))).flatMap((flags) =>
              boardCandidates.filter((_, at) => flags[at]),
            ),
          );
          meanings = boardMeanings(
            ordered.slice(board.start, board.start + BOARD_SIZE),
            ordered,
            boardCandidates.filter((text) => !rightForOne.has(text)),
            read.known,
          );
          if (!meanings) throw new InvalidDistractors(sessionId, "every wrong meaning of the board is one of its words' own");
          for (const text of rightForOne) {
            events.push({ event: 'checker_dropped', session_id: sessionId, position: board.start, type: 'matching', kind: 'option', text, reason: 'the checker calls it right for a board word' });
          }
        }
      } catch (error) {
        logger.info({
          event: 'session_preparation_attempt_failed',
          session_id: sessionId,
          stage: 'checker',
          item_count: items.length,
          check_count: checkItems.length,
          model_ms: modelMs,
          context_ms: contextMs,
          checker_ms: now() - checkerStarted,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // What the checker's answer does to each card: its three wrong options, its
      // context (D6's fallback when the checker reads another sense), and a
      // sentence card the practised word is not natural in (phase 27's degraded
      // path: a typed translation, D8).
      const final = shown.map((card) => {
        const key = keyOf(card.index);
        const { row } = card;
        let { type, answered, context, sentence, degradedReason } = card;
        const left = survivors.get(card.index);
        if (left) {
          for (const text of candidatesOf(card.index).filter((option) => !left.includes(option))) {
            events.push({ event: 'checker_dropped', session_id: sessionId, position: card.index, type, kind: 'option', text, reason: 'the checker calls it right' });
          }
          answered = { ...answered, distractors: left.slice(0, KEPT_DISTRACTORS), spares: left.slice(KEPT_DISTRACTORS) };
        }
        const contextFinding = findings.get(contextKeyOf(key));
        if (card.checkable && context && contextFinding) {
          const fits =
            contextFinding.task === 'meaning'
              ? meaningFits(contextFinding.meaning, glossMeanings(row))
              : contextFinding.task === 'words' &&
                // The answer form the card asks for, its lemma, and the saved form, which is right too.
                wordsFit(contextFinding.words, {
                  answer: row.answerForm ?? row.form,
                  lemma: row.lemma,
                  alternatives: [row.form, ...row.acceptedAnswers, ...answered.alternatives],
                });
          if (!fits) {
            const reading = contextFinding.task === 'meaning' ? contextFinding.meaning : contextFinding.task === 'words' ? contextFinding.words.join(', ') : '';
            events.push({ event: 'checker_dropped', session_id: sessionId, position: card.index, type, kind: 'context', text: context.text, reason: `the checker reads it as ${reading || 'nothing'}` });
            context = fallbackContext(row, card.checkable.task);
          }
        }
        const sentenceFinding = findings.get(key);
        const made = sentenceOf(answered);
        if (sentenceFinding?.task === 'translate' && made) {
          const practised = [made.word, row.form, row.lemma, ...(row.answerForm ? [row.answerForm] : []), ...row.acceptedAnswers, ...answered.alternatives];
          if (!translationUses(sentenceFinding.translation, practised)) {
            const reason = `the checker says it "${sentenceFinding.translation}", using neither ${made.word} nor an answer the card accepts`;
            events.push({ event: 'checker_dropped', session_id: sessionId, position: card.index, type, kind: 'sentence', text: made.hebrew, reason });
            type = 'typed_translation';
            answered = typedAnswered(row, NOTHING_GENERATED);
            degradedReason = reason;
            sentence = null;
            context = fallbackContext(row, 'explanation');
          }
        }
        if (degradedReason !== null) {
          events.push({ event: 'sentence_degraded', session_id: sessionId, position: card.index, type: card.planned, reason: degradedReason });
        }
        // Spec D6: a sense saved without an example has nothing to fall back on.
        if (!context && contextLanguageOf(type) !== null) {
          events.push({ event: 'context_missing', session_id: sessionId, position: card.index, type });
        }
        return { row, index: card.index, type, answered, context, sentence };
      });

      const written = await transaction(async ({ session, question, gloss }) => {
        // Conditional: a skip that landed during the model call wins, and this
        // transaction then writes nothing at all.
        if (!(await session.transition(sessionId, ['preparing'], 'ready'))) return false;
        // Phase 31 (spec D14). Again, under this write's own share lock: a merge
        // may have landed during the model call.
        const survivorGlosses = await gloss.resolveGlosses(ordered.map((row) => row.glossId));
        const generated = await question.insertGeneratedQuestions({
          userId: read.state.userId,
          enrollmentId: read.state.enrollmentId,
          targetLanguage: target,
          userLanguageCode: read.enrolled.source_language,
          questions: final.map(({ row, index, type, answered, context, sentence }) => ({
            glossId: survivorGlosses.get(row.glossId)?.id ?? row.glossId,
            variantId: row.variantId,
            form: row.form,
            lemma: row.lemma,
            partOfSpeech: row.partOfSpeech,
            lexemeId: row.lexemeId,
            type,
            ...generatedContent(row, type, answered, {
              tiles: type === 'letter_tiles' ? tilesFor(row.answerForm ?? row.form, LANGUAGES[target].alphabet, rng) : null,
              board: type === 'matching' && board && meanings ? { meanings, own: index - board.start } : null,
              gap: gaps[index],
            }),
            // Phase 34 (spec D6, D8, D12): stored as shown.
            ...contextColumns(type, context, sentence),
          })),
        });
        // Each choice shuffled on its own, a board's words once together; the
        // question order is the plan's and is not shuffled.
        await session.insertSessionQuestions(sessionId, shuffleSession(generated, rng));
        return true;
      });

      if (written) for (const event of events) logger.info(event);
      logger.info({
        event: written ? 'session_prepared' : 'session_preparation_dropped',
        session_id: sessionId,
        question_count: written ? read.context.length : 0,
        item_count: items.length,
        model_ms: modelMs,
        context_ms: contextMs,
        check_count: checkItems.length,
        checker_ms: checkerMs,
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

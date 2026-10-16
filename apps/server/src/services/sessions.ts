import type { AnswerRecord, Enrollment, SessionSource, SessionStatus, SpeechVerdict, TypedVerdict } from '@lang-tutor/core/api';
import { LlmTranscriptSchema, TypedVerdictSchema } from '@lang-tutor/core/api/schemas';
import {
  LIVE_DIMENSIONS,
  MAX_JUDGED_TEXT,
  evaluate,
  gatesScript,
  isJudged,
  isSpeaking,
  wrongScript,
  shuffleSession,
  soundPairs,
  speakable,
  spokenTarget,
  spokenVerdict,
  takesHelp,
  type AnswerInput,
  type Dimension,
  type JudgedQuestion,
  type MemoryState,
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
import { chooseWords, dueGlosses, liveDimensions, type ChoiceInput } from '../domain/choose';
import { DAY_NEW_CAP, NEW_PER_SESSION } from '../domain/chooseConstants';
import { findGap } from '../domain/cloze';
import {
  buildContextPrompt,
  contextColumns,
  contextItemFor,
  contextLanguageOf,
  fallbackContext,
  markFor,
  wordMapFor,
  type MapWord,
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
  type LearnerWord,
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
import { buildFitJudgePrompt, judgePrompt, parseFitJudge, parseJudge, ruleVerdict, type JudgeContext } from '../domain/judge';
import {
  ACCEPT_RENDERING,
  PREPARE_SESSION,
  PrepareSessionPayloadSchema,
  StockSessionPayloadSchema,
  acceptRenderingKey,
  type StockSessionPayload,
} from '../domain/jobs';
import { dropLoneMeets, keepCards, type CardUnit, type Refusal } from '../domain/keepCards';
import { LANGUAGES, type LanguageCode } from '../domain/languages';
import { BOARD_SIZE, planCards } from '../domain/plan';
import { dayState, withSessionInFlight } from '../domain/today';
import { progressChanges, type ProgressChange } from '../domain/progress';
import type { Devices, Path, SavedGloss, SessionRecord, SessionSummary } from '../domain/session';
import {
  SESSION_LENGTH,
  askableRenderings,
  attemptOf,
  isOpen,
  newSessionRecord,
  nextSource,
  pickRendering,
  sessionScore,
  step,
} from '../domain/session';
import { reminderForSession } from '../domain/reminders';
import { MAX_AVOID, MAX_LEARNER_WORDS } from '../domain/sentences';
import { classifyTaps } from '../domain/taps';
import type { Mark } from '../domain/marks';
import { buildSoundAlikePrompt, orderedPair, parseSoundAlike, type OrderedPair } from '../domain/soundAlike';
import { MIN_AUDIO_CHARS, parseTranscript, transcriptionSystem } from '../domain/speech';
import { chooseTargetPicks, owedWords, stockServes, stockToCheck, targetMode, type StockChoice, type TargetPickInput } from '../domain/targetPicker';
import { activeOn, readinessOf, recallOnDue } from '../domain/targets';
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
  TargetClosed,
  TargetNotFound,
  WrongScript,
} from '../errors';
import type { Logger } from '../logger';
import { authorizeEnrollment } from './access';
import { learnerDay } from './learnerDay';
import { readTargetDay } from './targetDayRead';
import type { LlmClient, ModelCallRecord } from './llm';
import type { SpeechTranscriber } from './speech';
import { closeOpenSession, lastAnswerDay, recordProgress, skipOpenSession } from './sessionEnd';
import { pathPayload, requestStock } from './stock';
import type { SessionTargetRow, TargetRow } from '../repo/targets';
import type { Repos, Transaction } from './transaction';

export type { Transaction } from './transaction';

/** Phase 34 (spec D4, D5). The cards that show wrong options, three of them. */
const CHOSEN: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'listen_choice', 'reverse_choice', 'cloze_choice']);

/** Phase 39 (spec D6). The type a card is generated as. A new_meaning goes
 *  through exactly the multiple-choice paths: its distractor item, its context
 *  item, its checker items, CHOSEN's surviving options and its stored content.
 *  Only its stored row differs: its type, and the known meanings of its pick. */
const generatedAs = (type: QuestionType): QuestionType => (type === 'new_meaning' ? 'multiple_choice' : type);

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

/** Phase 50 (spec D7). What the second look at an unheard transcript found:
 *  its best pair's score and form (null when no pair came back scored),
 *  whether the model was asked, and the wait. */
type SoundLook = { score: number | null; form: string | null; called: boolean; ms: number };

/** Phase 27. A judged answer: its verdict, and the session it was recorded in. */
export type JudgedResult = { verdict: TypedVerdict; session: SessionResult };

/** Phase 43 (spec D5). The session create answers, and whether this call made it. */
type NextSession = { sessionId: string; status: SessionStatus; source: SessionSource; created: boolean };

/** Phase 53 (spec D8). A stock written: its session, its path (phase 57), the targets its
 *  choice found ended on their date, whose events name it, and the stocks those left on their
 *  paths, retired, and (final review I1) their started sessions, skipped. Logged once its
 *  transaction commits. */
type Stocked = { sessionId: string; path: Path; endedOnDate: string[]; endedStocks: string[]; endedStarted: string[] };

/** Phase 53 (ruling R-D12). A stale stock retired, and the stock built in its place. */
type Replaced = Stocked & { retired: string };

/** Phase 53 (ruling R-D12). What the cheap half of the stale check read of one stock: the
 *  learner's today, the devices the stock was built for, and (phase 57) what it recorded of its
 *  target's day, which a check compares with today's. */
type MaybeStale = { stockId: string; today: string; devices: Devices; recorded: StockChoice | undefined };

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
  translationJudge,
  soundAlikeThreshold,
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
  /** Phase 45 (spec D3). The sentence translation's judge: it thinks before it
   *  answers, which a dropped detail needs, and the meaning judge does not. */
  translationJudge: LlmClient;
  /** Phase 50 (spec D4). The pronunciation score at which an unheard
   *  transcript is the card's word; its pairs are scored on `judge`. */
  soundAlikeThreshold: number;
}) {
  /**
   * Phase 50 (spec D1–D3, D6). The second look at an unheard transcript: its
   * pairs with the card's forms, scored by how alike they sound. The stored
   * scores are read first and only the missing pairs are asked, in one call;
   * the read, the call and the write each stand alone, outside any other
   * transaction (ADR 0001 R8). Null when there is nothing to pair, and when it
   * fails, which is logged: the transcript stays unheard, as before.
   */
  async function soundAlike(
    question: SpeakingQuestion,
    heard: string,
    language: LanguageCode,
    record: ModelCallRecord,
    sessionId: string,
  ): Promise<SoundLook | null> {
    const pairs = soundPairs(spokenTarget(question), heard);
    if (pairs.length === 0) return null;
    const started = now();
    const keyOf = ({ a, b }: OrderedPair) => `${a}\n${b}`;
    const asked = [...new Map(pairs.map(orderedPair).map((pair) => [keyOf(pair), pair])).values()];
    try {
      const stored = await transaction((repos) => repos.pronunciation.find(language, asked));
      const scores = new Map(stored.map((row) => [keyOf(row), row.score]));
      const missing = asked.filter((pair) => !scores.has(keyOf(pair)));
      if (missing.length > 0) {
        const raw = await judge({ ...buildSoundAlikePrompt(language, missing), record: { ...record, kind: 'sound_alike' } });
        const answered = parseSoundAlike(raw, missing.length);
        if (answered === null) throw new LlmUnavailable('the scores were unreadable');
        const fresh = missing.flatMap((pair, index) => {
          const score = answered[index];
          return score === null ? [] : [{ ...pair, score }];
        });
        await transaction((repos) => repos.pronunciation.insert(language, fresh));
        for (const row of fresh) scores.set(keyOf(row), row.score);
      }
      let best: { score: number; form: string } | null = null;
      for (const pair of pairs) {
        const score = scores.get(keyOf(orderedPair(pair)));
        if (score !== undefined && (best === null || score > best.score)) best = { score, form: pair.form };
      }
      return { score: best?.score ?? null, form: best?.form ?? null, called: missing.length > 0, ms: now() - started };
    } catch (error) {
      logger.info({
        event: 'sound_alike_failed',
        session_id: sessionId,
        question_type: question.type,
        sound_ms: now() - started,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Phase 57 (spec D1, D2, ADR 0014). The target a request names as its path: unknown, or
   * another enrollment's, is TargetNotFound, and another learner's is refused first, by the
   * same check its own enrollment would get (AccessDenied).
   */
  async function pathTarget(repos: Repos, actorUserId: string, enrolled: Enrollment, targetId: string): Promise<TargetRow> {
    const target = await repos.target.findTarget(targetId);
    if (!target) throw new TargetNotFound(targetId);
    if (target.enrollmentId !== enrolled.id) {
      await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId: target.enrollmentId, permission: 'session.practice' });
      throw new TargetNotFound(targetId);
    }
    return target;
  }

  /**
   * Phase 39 (spec D4, D5). The families of every saved gloss, derived from the dictionary and
   * `memory` (every saved gloss's) with the session's live skills. Phase 46 (spec D3): known_at
   * is the gloss's own, family or not. Phase 57 (ruling T5-k): the same for every path; only a
   * main-path stock records what changed.
   */
  async function readFamilies(
    repos: Repos,
    all: readonly SavedGloss[],
    memory: Parameters<typeof glossFamilies>[0]['memory'],
    devices: Devices,
  ) {
    const forms = await repos.dict.findLexemeForms({ lexemeIds: [...new Set(all.map((gloss) => gloss.lexemeId))] });
    const formsOf = new Map<string, string[]>();
    for (const row of forms) formsOf.set(row.lexemeId, [...(formsOf.get(row.lexemeId) ?? []), row.form]);
    const members = all.map((gloss) => ({
      glossId: gloss.glossId,
      lexemeId: gloss.lexemeId,
      lemma: gloss.lemma,
      key: gloss.key,
      savedAt: gloss.savedAt,
      forms: formsOf.get(gloss.lexemeId) ?? [],
      order: gloss.order,
      speakable: speakable(gloss.form),
      knownAt: gloss.knownAt,
    }));
    return glossFamilies({ saved: members, memory, live: liveDimensions(devices.listening, devices.speaking) });
  }

  /**
   * Phase 35, 43, 53; phase 57 (spec D1): the main path's choice, read on the owner's learner
   * day: the picker's input over the saved glosses in no target active that day, and the
   * families the choice refreshes, which are every saved gloss's. Null when the path has no
   * word, before anything else is read.
   */
  async function readMain(repos: Repos, enrolled: Enrollment, devices: Devices) {
    const { session, vocabulary } = repos;
    const enrollmentId = enrolled.id;
    const all = await vocabulary.listSavedGlosses(enrollmentId);
    if (all.length === 0) return null;
    const at = now();
    const today = await learnerDay(repos, enrolled.user_id, at);
    // Phase 57 (spec D1). A word leaves the main path while an active target holds it.
    const held = new Set((await repos.target.listActive(enrollmentId, today)).flatMap((target) => target.glossIds));
    const saved = all.filter((gloss) => !held.has(gloss.glossId));
    if (saved.length === 0) return null;
    // Phase 35 (spec D5, D10). The words, each with a dimension and a rung,
    // from what the learner knows: memory and levels, on the owner's day,
    // with what that day already asked and introduced. At most one gloss per
    // key, across headwords (phase 31 D18), is chooseWords' rule now.
    const glossIds = all.map((gloss) => gloss.glossId);
    const memory = await repos.memory.findRows({ enrollmentId, glossIds });
    const levels = await repos.progress.findRows({ enrollmentId, glossIds, savedBy: null });
    // Phase 39 (spec D4, D5). The families, and what was recorded of them.
    const stored = await repos.glossFamilies.load(enrollmentId);
    const families = await readFamilies(repos, all, memory, devices);
    const waiting = new Set([...families.state].filter(([, state]) => state === 'waiting').map(([glossId]) => glossId));
    // Phase 37 (spec D1, D7). Today's answers leave the returns owed and the
    // words done for the day.
    const introduced = await session.findIntroducedOn(enrollmentId, today);
    // Phase 43 (spec D4). Picked beside the path's started session, whose saved
    // glosses count as answered today: the two ask different words while the
    // path has others, and its first meetings are today's new words too.
    const { started } = await session.findOpen(enrollmentId, null);
    const inFlight = started ? (await session.findSessionGlosses(started.id)).filter((glossId) => glossIds.includes(glossId)) : [];
    const met = new Set([...memory.map((row) => row.glossId), ...introduced]);
    const { steps, done, extraNew } = withSessionInFlight(
      dayState(await session.findAnswersOn(enrollmentId, today), new Set(introduced)),
      inFlight,
      met,
    );
    const choice: ChoiceInput = {
      saved,
      memory,
      levels,
      today,
      steps,
      done,
      // Spec D8: every path's first meetings today count toward the day's cap.
      newToday: introduced.length + extraNew,
      listening: devices.listening,
      speaking: devices.speaking,
      rng,
      // Phase 54 (spec D2), phase 60 (D1): a family's new meaning is no ladder, asked or not.
      families: { familyOf: families.familyOf, waiting, newMeanings: families.newMeanings },
    };
    return { path: null, at, today, saved, families, stored, picks: chooseWords(choice) };
  }

  /**
   * Phase 57 (spec D1, D6–D9, rulings T3-j, T3-m, T3-n). A target path's choice, read on the
   * owner's learner day: its day (readTargetDay), and the picks its picker makes of it beside
   * the path's started session, whose graded cards it credits; owed work first, and practice
   * more when the session in flight covers all of it, so the path always has a next session.
   * With what its stock records of the day: the cap, readiness, the words at 100% and by FSRS
   * on the date, and the words owed (none for practice more). Null when the target is no
   * longer active or has no word.
   */
  async function readTarget(repos: Repos, enrolled: Enrollment, target: TargetRow, devices: Devices) {
    const enrollmentId = enrolled.id;
    const at = now();
    const today = await learnerDay(repos, enrolled.user_id, at);
    if (!activeOn(target, today)) return null;
    const saved = await repos.vocabulary.listSavedGlosses(enrollmentId);
    const read = await readTargetDay(repos, enrolled, target, devices, today, saved);
    if (!read) return null;
    const { day, glossIds, live, canSay } = read;
    // Phase 60 (spec D1, "targets too"). The families, over every saved gloss as the main path
    // reads them: a family's new meaning starts with its new_meaning card, never a ladder.
    const memory = await repos.memory.findRows({ enrollmentId, glossIds: saved.map((gloss) => gloss.glossId) });
    const families = await readFamilies(repos, saved, memory, devices);
    const levels = await repos.progress.findRows({ enrollmentId, glossIds, savedBy: null });
    const { started } = await repos.session.findOpen(enrollmentId, target.id);
    const cards = started ? await repos.session.findSessionCards(started.id) : [];
    // Ruling T3-n (spec D8). The day's room for new words: the cap less every path's first
    // meetings today and this path's session in flight's.
    const introduced = await repos.session.findIntroducedOn(enrollmentId, today);
    const met = new Set([...memory.map((row) => row.glossId), ...introduced]);
    const meeting = new Set(cards.map((card) => card.glossId).filter((glossId) => glossIds.includes(glossId) && !met.has(glossId)));
    const input: TargetPickInput = {
      day,
      mode: targetMode(day),
      levels: new Map(levels.map((row) => [`${row.glossId}|${row.dimension}`, row.level])),
      known: new Set(memory.map((row) => row.glossId)),
      newMeanings: families.newMeanings,
      keys: new Map(saved.map((gloss) => [gloss.glossId, gloss.key])),
      // Ruling T3-j: a ladder's intro stage grades nothing.
      inFlight: cards.filter((card) => !card.intro),
      newRoom: Math.max(0, DAY_NEW_CAP - introduced.length - meeting.size),
    };
    let mode = input.mode;
    let picks = chooseTargetPicks(input);
    // Ruling T3-m. Owed work all asked by the session in flight: practice more instead.
    if (picks.length === 0 && mode === 'owed') {
      mode = 'more';
      picks = chooseTargetPicks({ ...input, mode });
    }
    const rowsOf = new Map<string, { dimension: Dimension; state: MemoryState }[]>();
    for (const row of memory) rowsOf.set(row.glossId, [...(rowsOf.get(row.glossId) ?? []), row]);
    const fsrsReady = glossIds.filter(
      (glossId) => readinessOf(target.kind, recallOnDue(rowsOf.get(glossId) ?? [], live, canSay(glossId), target.dueOn)) === 'ready',
    );
    const row: SessionTargetRow = {
      targetId: target.id,
      daysLeft: day.daysLeft,
      capHalves: day.capHalves,
      readinessPct: day.readinessPct,
      readyCount: day.readyCount,
      wordCount: glossIds.length,
      fsrsReadyCount: fsrsReady.length,
      owedGlossIds: owedWords(day, mode),
    };
    return { path: target.id, at, today, saved: saved.filter((gloss) => glossIds.includes(gloss.glossId)), families, picks, row };
  }
  type MainRead = NonNullable<Awaited<ReturnType<typeof readMain>>>;
  type TargetRead = NonNullable<Awaited<ReturnType<typeof readTarget>>>;
  type ChoiceRead = MainRead | TargetRead;

  /** Phase 57 (spec D1). A path's choice: the main path's, or its target's. Null when the path
   *  has nothing to ask, or its target is no longer active. */
  async function readChoice(repos: Repos, enrolled: Enrollment, devices: Devices, path: Path): Promise<ChoiceRead | null> {
    if (path === null) return readMain(repos, enrolled, devices);
    const target = await repos.target.findTarget(path);
    return target && target.enrollmentId === enrolled.id ? readTarget(repos, enrolled, target, devices) : null;
  }

  /**
   * Phase 53 (spec D6, D8). A stock's picks as its preparation is given them, each with a
   * rendering to ask, in the order chosen. Null when no chosen gloss has a rendering to ask.
   */
  async function choosePicks(repos: Repos, enrolled: Enrollment, read: ChoiceRead) {
    const chosen = read.picks;
    // Phase 31 (spec D12). One rendering per gloss, uniformly over every form of
    // every member that agrees with the gloss, the saved form always among them.
    // No model call: a lemma form not yet rendered joins once its job lands.
    const renderings = await repos.dict.findGlossRenderings({
      glossIds: chosen.map((choice) => choice.glossId),
      userLanguageCode: enrolled.source_language,
    });
    const savedById = new Map<string, SavedGloss>(read.saved.map((gloss) => [gloss.glossId, gloss]));
    const { introductions } = read.families;
    const picks = chosen.flatMap((choice) => {
      const rendering = pickRendering(askableRenderings(savedById.get(choice.glossId)!, renderings), rng);
      if (!rendering) return [];
      const { dimension, rung, level, r, ladder } = choice;
      const step = choice.cls === 'STEP';
      // Phase 39 (spec D6). A family's next meaning, never asked, is introduced with the known ones.
      // Phase 60 (spec D1) on a target path: the picker's start of it, NEW and no ladder.
      const knownMeanings =
        read.path === null || (choice.cls === 'NEW' && !ladder) ? introductions.get(choice.glossId) : undefined;
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
          // Phase 54 (spec D3, D7). The prepare job asks a ladder pick as its four cards.
          ladder,
        },
      ];
    });
    return picks.length === 0 ? null : picks;
  }
  type ChosenStock = NonNullable<Awaited<ReturnType<typeof choosePicks>>>;

  /**
   * Phase 43 (spec D3). A stock chosen from `read`, written: the session inserted preparing
   * on the read's path for `devices`, and its preparation enqueued in the same transaction,
   * so the row and its job commit together. Phase 53 (spec D8, D12): the session records the
   * learner day its words were chosen on. Phase 57 (spec D1, D2, D10): a target path's stock
   * records its target's day (session_targets) and is planned as a target's (ruling T3-l);
   * the main path's records each target whose date has passed as ended on it, naming the
   * session, retires that target path's unstarted stock and skips its started one (final
   * review I1: its answers counted once as a skip's, on its last answer's learner day; every
   * ended path's rows change before the progress lock is first taken, as ADR 0014 R4 orders
   * it), and refreshes the families. The caller holds the path's next-session lock.
   */
  async function writeStock(repos: Repos, enrolled: Enrollment, devices: Devices, read: ChoiceRead, picks: ChosenStock): Promise<Stocked> {
    const { session, vocabulary, jobs } = repos;
    const enrollmentId = enrolled.id;
    const sessionId = await session.insertPreparingSession(enrolled.user_id, enrollmentId, devices, read.today, read.path);
    const endedOnDate: string[] = [];
    const endedStocks: string[] = [];
    const endedStarted: string[] = [];
    if (read.path !== null) {
      await repos.target.insertSessionTarget(sessionId, read.row);
    } else {
      // Phase 53 (spec D8), phase 57 (spec D10). A target ends by itself the day after its
      // date; the first main-path stock chosen from then on writes its ended_on_date. Its
      // path is off home: an unstarted stock left on it is retired, and a session started on it,
      // which nothing could resume or skip any more, is skipped (final review I1).
      for (const target of await repos.target.listEndedUnrecorded(enrollmentId, read.today)) {
        await repos.target.insertEvent({
          targetId: target.id,
          kind: 'ended_on_date',
          before: null,
          after: { due_on: target.dueOn },
          actorUserId: null,
          sessionId,
        });
        endedOnDate.push(target.id);
        const { stock, started } = await session.findOpen(enrollmentId, target.id);
        if (stock?.source === 'list' && (await session.retireStock(stock.id))) endedStocks.push(stock.id);
        // Re-review N2: only the row here; every ended path's rows change before the progress
        // lock, which the loop below takes. Ruling I1-c: on its last answer's learner day.
        const day = started ? await lastAnswerDay(repos, enrolled.user_id, started.id, read.today) : read.today;
        if (started && (await closeOpenSession(repos, started.id, day))) endedStarted.push(started.id);
      }
      for (const skipped of endedStarted) await recordProgress(repos, skipped, enrollmentId);
      // Phase 39 (spec D4). The refresh is recorded once the session exists, so
      // each event names it; one that changed nothing writes nothing. Phase 46
      // (spec D3): every gloss known for the first time is stamped, family or not.
      const { families, stored, at } = read;
      if (families.newlyKnown.size > 0) {
        await vocabulary.markKnown({ enrollmentId, glossIds: [...families.newlyKnown], at: new Date(at).toISOString() });
      }
      const write = familyChanges(stored, families);
      if (!isEmptyFamilyWrite(write)) await repos.glossFamilies.apply(enrollmentId, sessionId, write);
    }
    await jobs.enqueue(PREPARE_SESSION, {
      session_id: sessionId,
      picks,
      listening: devices.listening,
      speaking: devices.speaking,
      ...(read.path === null ? {} : { target: true }),
    });
    return { sessionId, path: read.path, endedOnDate, endedStocks, endedStarted };
  }

  /**
   * Phase 43 (spec D3). Phase 19's list branch of create, shared by create and
   * the stock job: the path's words read and chosen, then written. NoSavedWords when
   * the path has nothing to ask.
   */
  async function stockNext(repos: Repos, enrolled: Enrollment, devices: Devices, path: Path): Promise<Stocked> {
    const read = await readChoice(repos, enrolled, devices, path);
    const picks = read ? await choosePicks(repos, enrolled, read) : null;
    if (!read || !picks) throw new NoSavedWords(enrolled.id);
    return writeStock(repos, enrolled, devices, read, picks);
  }

  /**
   * Phase 53 (ruling R-D12), per path since phase 57 (spec D2, final review C1). The cheap half
   * of the stale check: a target path's list stock that stockToCheck says may no longer serve
   * its target's day: chosen on an earlier learner day than today, or chosen as practice more
   * (it recorded no owed word), which a miss in the session it was chosen beside turns stale the
   * same day. A seed, a stock from before phase 53 (no chosen_on), one chosen today for owed
   * work, and any of the main path's never are: the main path plays a stock as it is (phase 43
   * R5), without reading anything. Answers what it read, or null. `stock` is unstarted:
   * findOpen's.
   */
  async function mayBeStale(repos: Repos, enrolled: Enrollment, stock: SessionSummary, path: Path): Promise<MaybeStale | null> {
    if (path === null || stock.source !== 'list') return null;
    const choice = await repos.session.findStockChoice(stock.id);
    if (!choice || choice.chosenOn === null) return null;
    const today = await learnerDay(repos, enrolled.user_id, now());
    const recorded = await repos.target.findSessionTarget(stock.id, path);
    if (!stockToCheck({ chosenOn: choice.chosenOn, owedGlossIds: recorded?.owedGlossIds ?? [] }, today)) return null;
    return { stockId: stock.id, today, devices: { listening: choice.listening, speaking: choice.speaking }, recorded };
  }

  /**
   * Phase 53 (spec D12, ruling R-D12), per path since phase 57 (spec D2, final review C1). A
   * target path's stock that mayBeStale holds (chosen on an earlier learner day, or as practice
   * more) is played as it is (phase 43 R5) unless today's choice of its target differs from the
   * one it recorded, in its cap or in its owed words (stockServes): then it is retired and the
   * next is built in its place, for the devices it was built for. A target no longer active, a
   * choice with nothing to ask or no rendering, leave the stock as it is, and so does a start
   * that took it first. The caller holds the path's next-session lock and read `stock` under
   * it. `checked` is mayBeStale's answer from before the lock: a stock's day and record are
   * written with it and never change, so for the same stock they are not read again. Answers
   * the stock built, or null.
   */
  async function replaceIfStale(
    repos: Repos,
    enrolled: Enrollment,
    stock: SessionSummary,
    path: Path,
    checked: MaybeStale | null = null,
  ): Promise<Replaced | null> {
    const stale = checked?.stockId === stock.id ? checked : await mayBeStale(repos, enrolled, stock, path);
    if (!stale || path === null) return null;
    const read = await readChoice(repos, enrolled, stale.devices, path);
    if (!read || read.path === null) return null;
    if (stockServes(stale.recorded, read.row)) return null;
    const picks = await choosePicks(repos, enrolled, read);
    if (!picks || !(await repos.session.retireStock(stock.id))) return null;
    return { retired: stock.id, ...(await writeStock(repos, enrolled, stale.devices, read, picks)) };
  }

  /** Phase 43 (spec D3). A stock made, once its transaction committed. Phase 53 (spec D8):
   *  each target its choice found ended on its date, first, and (phase 57) the stock each
   *  left on its path, retired, and the session started there, skipped (final review I1). */
  function logStocked(enrollmentId: string, stocked: Stocked, reason: StockSessionPayload['reason'] | 'create' | 'stale_target'): void {
    for (const targetId of stocked.endedOnDate) logger.info({ event: 'target_ended', target_id: targetId, how: 'on_date' });
    for (const sessionId of stocked.endedStocks) {
      logger.info({ event: 'session_retired', enrollment_id: enrollmentId, session_id: sessionId, reason: 'target_ended' });
    }
    for (const sessionId of stocked.endedStarted) logger.info({ event: 'session_skipped', session_id: sessionId, reason: 'target_ended' });
    logger.info({
      event: 'session_stocked',
      enrollment_id: enrollmentId,
      session_id: stocked.sessionId,
      reason,
      ...(stocked.path === null ? {} : { target_id: stocked.path }),
    });
  }

  /** Phase 53 (ruling R-D12). A stale stock retired, and the stock built in its place. */
  function logReplaced(enrollmentId: string, replaced: Replaced): void {
    logger.info({ event: 'session_retired', enrollment_id: enrollmentId, session_id: replaced.retired, reason: 'stale_target' });
    logStocked(enrollmentId, replaced, 'stale_target');
  }

  /**
   * Phase 57 (ruling T5-q). How many saved words a path can practise: a target path's is what
   * its list holds as ever (the count of saved words), the main path's only those in no active
   * target, so a learner whose every word is in a target sees "save words first" on My words
   * rather than a create that 409s. A target's words are saved ones (unsaving takes a word out
   * of every target), so the held ones are among the entries.
   */
  async function savedOn(repos: Repos, enrolled: Enrollment, path: Path): Promise<number> {
    const saved = await repos.vocabulary.countEntries(enrolled.id);
    if (path !== null) return saved;
    const today = await learnerDay(repos, enrolled.user_id, now());
    const held = new Set((await repos.target.listActive(enrolled.id, today)).flatMap((active) => active.glossIds));
    return Math.max(0, saved - held.size);
  }

  /**
   * Phase 57 (spec D11). How many words wait on a path: on the main path, its words chooseWords
   * calls due (dueGlosses), with the live skills of the enrollment's newest session; on a
   * target's, its words with work owed today (none once it ended).
   */
  async function waitingOn(repos: Repos, enrolled: Enrollment, target: TargetRow | null): Promise<number> {
    const enrollmentId = enrolled.id;
    const today = await learnerDay(repos, enrolled.user_id, now());
    const devices = (await repos.session.findNewestDevices(enrollmentId)) ?? { listening: false, speaking: false };
    if (target !== null) {
      if (!activeOn(target, today)) return 0;
      const words = await repos.vocabulary.findSavedWords({ enrollmentId, glossIds: await repos.target.listWordIds(target.id) });
      const read = await readTargetDay(repos, enrolled, target, devices, today, words);
      return read ? read.day.words.filter((word) => word.state === 'owed').length : 0;
    }
    // A memory row is a saved gloss's (its key is the vocabulary entry): no read of the list.
    const held = new Set((await repos.target.listActive(enrollmentId, today)).flatMap((active) => active.glossIds));
    const memory = (await repos.memory.findEnrollmentRows(enrollmentId)).filter((row) => !held.has(row.glossId));
    return dueGlosses(memory, liveDimensions(devices.listening, devices.speaking), today).length;
  }

  const service = {
    /**
     * The next session to play (phase 43, spec D5), on a path (phase 57, spec D1: the main
     * path, or the target `path` names). A started session of the path is resumed, not
     * replaced: SessionOpen. The path's stock is the next one, answered as it is, built for
     * whichever device asked first. Otherwise the enrollment's first session is the seed, the
     * main path's, ready at once, and every later one is built here from the path's words,
     * preparing. The indexes (repo -> SessionOpen) are what hold under a race. Phase 53
     * (ruling R-D12): a target's stock chosen on an earlier day whose day is stale is replaced
     * first, and the new one answered; since phase 57 (final review C1) a practice-more stock
     * too, the same day, once today owes work it does not serve. A target that is not the enrollment's is
     * TargetNotFound (another learner's, AccessDenied), and one no longer active TargetClosed.
     */
    createNextSession: async (actorUserId: string, enrollmentId: string, options: Devices, path: Path = null): Promise<NextSession> => {
      const { stocked, replaced, ...next } = await transaction(async (repos): Promise<NextSession & { stocked?: Stocked; replaced?: Replaced }> => {
        const { session, question } = repos;
        // No implicit creation: an unknown enrollment is a 404, another
        // learner's a 403, both before anything is written.
        const enrolled = await authorizeEnrollment(repos, logger, {
          actorUserId,
          enrollmentId,
          permission: 'session.practice',
        });
        if (path !== null) {
          const target = await pathTarget(repos, actorUserId, enrolled, path);
          if (!activeOn(target, await learnerDay(repos, enrolled.user_id, now()))) throw new TargetClosed(path);
        }

        // Review C1. A double tap, or the stock job, waits here for the other.
        await session.lockNextSession(enrollmentId, path);
        const open = await session.findOpen(enrollmentId, path);
        if (open.started) throw new SessionOpen(enrollmentId);
        if (open.stock) {
          // Phase 53 (ruling R-D12). Answered as it is, unless its target's day is stale.
          const replaced = await replaceIfStale(repos, enrolled, open.stock, path);
          if (replaced) return { sessionId: replaced.sessionId, status: 'preparing', source: 'list', created: true, replaced };
          return { sessionId: open.stock.id, status: open.stock.status, source: open.stock.source, created: false };
        }

        // Phase 57 (spec D2). The seed is the main path's: a target's path never plays it.
        if (path === null && nextSource((await session.findLatest(enrollmentId, 'any')) !== undefined) === 'seed') {
          const pool = await question.loadQuestionPool(
            enrolled.target_language,
            enrolled.source_language,
          );
          // Checked here rather than left to pickQuestions, whose plain Error was a
          // 500: a language with no seeded questions is an answer, not a failure.
          if (pool.length < SESSION_LENGTH) throw new InsufficientQuestions(enrollmentId, pool.length);
          const record = newSessionRecord(enrolled.user_id, pool, rng);
          const sessionId = await session.insertSession(enrolled.user_id, enrollmentId, record.questions, options);
          return { sessionId, status: 'ready', source: 'seed', created: true };
        }

        const stocked = await stockNext(repos, enrolled, options, path);
        return { sessionId: stocked.sessionId, status: 'preparing', source: 'list', created: true, stocked };
      });
      if (replaced) logReplaced(enrollmentId, replaced);
      if (stocked) logStocked(enrollmentId, stocked, 'create');
      return next;
    },

    /**
     * Phase 43 (spec D2). Starts a ready session, and asks for the next one in
     * stock, built for the device that started this one (ruling R2). Started
     * already: a no-op. A session that is not ready has nothing to start;
     * another started session of its path is SessionOpen. Phase 57 (spec D2): the stock
     * asked for is the next of the session's path only.
     */
    startSession: async (actorUserId: string, sessionId: string, devices: Devices): Promise<{ sessionId: string; status: SessionStatus }> => {
      const started = await transaction(async (repos) => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const state = await repos.session.findState(sessionId);
        if (!state) throw new SessionNotFound(sessionId);
        if (state.status !== 'ready') throw new SessionNotReady(sessionId, state.status);
        const changed = await repos.session.markStarted(sessionId);
        if (changed) await requestStock(repos, { enrollment_id: enrolled.id, reason: 'start', ...devices, ...pathPayload(state.targetId) });
        return changed;
      });
      if (started) logger.info({ event: 'session_started', session_id: sessionId, by: 'start' });
      return { sessionId, status: 'ready' };
    },

    /** Resume and the poll both read through this. A completed session also
     *  carries what it did to the saved words. */
    getSession: (actorUserId: string, sessionId: string): Promise<SessionResult> =>
      transaction(async (repos) => {
        await authorizeSession(repos, logger, actorUserId, sessionId);
        const record = await repos.session.loadSession(sessionId);
        if (!record) throw new SessionNotFound(sessionId);
        return { ...record, progress: await progressOf(repos, sessionId, record) };
      }),

    /** What the home screen needs in one read, of one path (phase 57, spec D1: the main
     *  path, or the target `path` names). Phase 43 (spec D6): the path's started session,
     *  else its stock, else its newest session if it failed, so a failure is never silent.
     *  Spec D8: an unstarted list session offered is logged with its status, which counts how
     *  often a learner found it ready. Phase 53 (ruling R-D12): home learns of the stock
     *  here, so a target's stock chosen on an earlier day is checked here, and offered
     *  replaced when its day is stale. The path's lock is taken only when the cheap half
     *  holds (a target's stock chosen on an earlier day, or as practice more: final review
     *  C1), and the stock is read again under it. Phase 57 (spec D11): and how many of the
     *  path's words wait (waitingOn). */
    currentSession: async (
      actorUserId: string,
      enrollmentId: string,
      path: Path = null,
    ): Promise<{ current: (SessionSummary & { started: boolean }) | null; nextSource: SessionSource; savedCount: number; dueCount: number }> => {
      const read = await transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'session.practice' });
        const target = path === null ? null : await pathTarget(repos, actorUserId, enrolled, path);
        let open = await repos.session.findOpen(enrollmentId, path);
        let replaced: Replaced | null = null;
        // Phase 53 (ruling R-D12). The lock only for a stock that its target's day can have made
        // stale (mayBeStale); what that read is not read again for the same stock.
        const checked = !open.started && open.stock ? await mayBeStale(repos, enrolled, open.stock, path) : null;
        if (checked) {
          await repos.session.lockNextSession(enrollmentId, path);
          open = await repos.session.findOpen(enrollmentId, path);
          replaced = !open.started && open.stock ? await replaceIfStale(repos, enrolled, open.stock, path, checked) : null;
          if (replaced) open = { stock: { id: replaced.sessionId, status: 'preparing', source: 'list', answered: 0, total: 0 } };
        }
        const latest = await repos.session.findLatest(enrollmentId, path);
        // The seed is the main path's (phase 57, spec D2): any session at all puts it behind.
        const any = latest ?? (await repos.session.findLatest(enrollmentId, 'any'));
        return {
          // Final review N1: whether it was started, which a session left before any answer is.
          current: open.started
            ? { ...open.started, started: true }
            : open.stock
              ? { ...open.stock, started: false }
              : latest?.status === 'failed'
                ? { ...latest, started: false }
                : null,
          offered: open.started ? undefined : open.stock,
          nextSource: path === null ? nextSource(any !== undefined) : ('list' as const),
          savedCount: await savedOn(repos, enrolled, path),
          dueCount: await waitingOn(repos, enrolled, target),
          replaced,
        };
      });
      const { offered, replaced, ...home } = read;
      if (replaced) logReplaced(enrollmentId, replaced);
      if (offered && offered.source === 'list') {
        logger.info({
          event: 'session_offered',
          enrollment_id: enrollmentId,
          session_id: offered.id,
          status: offered.status,
          ...(path === null ? {} : { target_id: path }),
        });
      }
      return home;
    },

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
        // Phase 20. The answers given before the skip are real answers (skipOpenSession).
        const changed = await skipOpenSession(repos, sessionId, enrolled.id, day);
        if (changed) {
          // Phase 43 (spec D3). The next session in stock, if this was it. Not
          // after the seed (ruling R8): it is played before anything is saved,
          // and a stock built behind the first saves would hold one word.
          // Phase 57 (spec D2): its path's.
          if (state.source === 'list') {
            await requestStock(repos, { enrollment_id: enrolled.id, reason: 'skip', ...pathPayload(state.targetId) });
          }
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
      {
        retry = false,
        hintOpened,
        fits = false,
        tapped = [],
      }: { retry?: boolean; hintOpened?: boolean; fits?: boolean; tapped?: readonly number[] } = {},
    ): Promise<SessionResult> => {
      // The transaction returns its outcome and the log fires after it resolves:
      // a commit that fails after completeSession must not leave a log claiming a
      // session the database never recorded.
      const { result, justCompleted, tapsLogged } = await transaction(async (repos) => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);

        // Phase 59 (spec D4, D5). The words tapped on a sentence translation, by
        // its stored map; a tap on the target is help, so it reaches `step` as such.
        const tappedAt = retry ? loaded.answers.length - 1 : loaded.answers.length;
        const tappedOn = loaded.questions[tappedAt];
        const taps =
          tapped.length > 0 && tappedOn?.id === questionId && tappedOn.type === 'sentence_translation'
            ? classifyTaps(await repos.question.findWords(questionId), tapped)
            : [];
        if (taps.some((tap) => tap.kind === 'target') && ('text' in answer || 'pass' in answer)) answer = { ...answer, helped: true };

        // Phase 19. Preparing, skipped and failed sessions take no answers. A
        // completed one still reaches `step`, whose replay path answers a retry.
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }

        // Four failure modes, four domain outcomes, four errors — the domain
        // decides what is wrong, this layer only names it.
        const outcome = step(loaded, questionId, answer, {
          retry,
          fits,
          languages: { target: enrolled.target_language as LanguageCode, learner: enrolled.source_language as LanguageCode },
        });
        if (outcome.status === 'invalid_question') throw new QuestionDesynced(questionId);
        if (outcome.status === 'wrong_answer_kind') throw new AnswerKindMismatch(questionId);
        if (outcome.status === 'out_of_range') {
          throw new OptionOutOfRange('option_index' in answer ? answer.option_index : -1);
        }
        // answerBySpeech judges before it gets here, with the same pure function.
        if (outcome.status === 'unheard') throw new Error('an unheard transcript reached submitAnswer');
        // Phase 39 (spec D10). `step` refuses before anything is recorded, so the
        // card stays as it was; the log is the only trace of the refusal.
        if (outcome.status === 'wrong_script') {
          const question = loaded.questions.find((q) => q.id === questionId)!;
          logger.info({ event: 'answer_wrong_script', session_id: sessionId, question_type: question.type });
          // `step` refused by this gate, so it names a language here.
          const expected =
            gatesScript(question, enrolled.target_language as LanguageCode, enrolled.source_language as LanguageCode) ??
            (enrolled.target_language as LanguageCode);
          throw new WrongScript(questionId, LANGUAGES[expected].name);
        }
        // A replay reports justCompleted: false, so retrying a completed session
        // logs nothing and writes no progress.
        if (outcome.status === 'replayed') {
          const progress = await progressOf(repos, sessionId, outcome.record);
          return { result: { ...outcome.record, progress }, justCompleted: false, tapsLogged: null };
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
          const askedType = loaded.questions[loaded.answers.length].type;
          const hinted = askedType === 'cloze_typed' ? { hintOpened: hintOpened ?? null } : {};
          // Phase 55 (spec D6): only a card that takes help, tiles or typed, records whether it was helped.
          const helps = takesHelp(askedType) ? { helped: 'helped' in answer ? answer.helped ?? null : null } : {};
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
                  ...helps,
                },
          );
        }

        // Phase 59 (spec D5). Stored with the card's answer, once per word: a
        // second try re-sending them adds only the new ones.
        const added = taps.length > 0 ? await repos.session.insertTaps(sessionId, tappedAt, taps) : [];

        // Phase 43 (spec D2). A first answer starts a session no start call
        // started (an older app, a bot), and asks for the next one in stock.
        // Another started session of its path refuses it here, before anything
        // commits. Phase 57 (spec D2): the stock asked for is its path's.
        const pathOf = async () => (await repos.session.findState(sessionId))?.targetId ?? null;
        if (outcome.recorded === 'answer' && loaded.answers.length === 0 && (await repos.session.markStarted(sessionId))) {
          await requestStock(repos, { enrollment_id: enrolled.id, reason: 'answer', ...pathPayload(await pathOf()) });
        }

        if (outcome.justCompleted) {
          const endedAt = now();
          const day = await learnerDay(repos, enrolled.user_id, endedAt);
          await repos.session.completeSession(sessionId, day);
          // Phase 52 (spec D6). The latest reminder the learner was sent today, if no
          // session has claimed it yet, is the one this session answers: "practised
          // after a reminder" becomes a row. The learner is the enrollment's owner, as
          // for the day, so a tutor finishing a session marks the learner's reminder.
          const reminderId = reminderForSession(await repos.reminders.sentOnDay(enrolled.user_id, day), endedAt);
          if (reminderId) await repos.reminders.markSession(reminderId, sessionId);
          await recordProgress(repos, sessionId, enrolled.id);
          // Phase 43 (spec D3). A stock that failed, or was never built, is
          // built now; one already there makes this a no-op. Its path's (phase 57).
          await requestStock(repos, { enrollment_id: enrolled.id, reason: 'complete', ...pathPayload(await pathOf()) });
        }

        const progress = await progressOf(repos, sessionId, outcome.record);
        return { result: { ...outcome.record, progress }, justCompleted: outcome.justCompleted, tapsLogged: added.length > 0 ? { position: tappedAt, taps: added } : null };
      });

      // Phase 59 (spec D5). Which words were looked up, and which list words took a miss.
      if (tapsLogged) {
        logger.info({
          event: 'answer_tapped',
          session_id: sessionId,
          position: tapsLogged.position,
          taps: tapsLogged.taps.length,
          tap_misses: tapsLogged.taps.filter((tap) => tap.kind === 'list').map((tap) => tap.glossId),
        });
      }
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
      input: { questionId: string; audio: string; mimeType: string; retry?: boolean; helped?: boolean },
    ): Promise<SpeechResult> => {
      const retry = input.retry ?? false;
      type Checked = { replay: SpeechResult } | { current: SpeakingQuestion; language: LanguageCode; record: ModelCallRecord };
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
          const stored = of === 'retry' ? answer.retry_verdict : answer.verdict;
          const heard = (of === 'retry' ? answer.retry_answer_string : answer.answer_string) ?? '';
          // Phase 56 (spec D4). A helped spoken answer is the one given up with
          // a transcript (a pass stores none): it was heard, so it replays understood.
          const verdict = stored === 'gave_up' && heard !== '' ? 'understood' : stored;
          // Ruling R1: only a recorded spoken answer is replayed; any other
          // answer to this card means this upload is stale.
          if (verdict !== 'understood' && verdict !== 'alternative') {
            throw new QuestionDesynced(input.questionId);
          }
          const progress = await progressOf(repos, sessionId, loaded);
          const replay: SpeechResult = {
            heard,
            verdict,
            session: { ...loaded, progress },
          };
          return { replay };
        }
        if (!isSpeaking(attempt.question)) throw new AnswerKindMismatch(input.questionId);
        return {
          current: attempt.question,
          language: enrolled.target_language as LanguageCode,
          // Phase 47 (spec D3).
          record: { kind: 'transcription', sessionId, enrollmentId: enrolled.id, userId: enrolled.user_id },
        };
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
            record: checked.record,
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

      const letters = spokenVerdict(checked.current, heard);
      // Phase 50 (spec D1, D5). A transcript whose letters are not the word gets
      // a second look by sound; at the threshold it is the word, understood.
      const look = letters === 'unheard' ? await soundAlike(checked.current, heard, checked.language, checked.record, sessionId) : null;
      const soundsLike = look !== null && look.score !== null && look.score >= soundAlikeThreshold ? look.form : null;
      const verdict: SpeechVerdict = soundsLike !== null ? 'understood' : letters;
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
        // Phase 50 (spec D7).
        ...(look ? { sound_score: look.score, sounds_like: look.form, sound_ms: look.ms, sound_called: look.called } : {}),
        // Phase 56 (spec D4): said with help, so recorded given up.
        ...(input.helped ? { helped: true } : {}),
      });
      // Phase 56 (spec D2). `helped` travels with the transcript, so `step` records a helped answer given up.
      const helps = input.helped === undefined ? {} : { helped: input.helped };
      const answer: AnswerInput = soundsLike !== null ? { heard, sounds_like: soundsLike, ...helps } : { heard, ...helps };
      const session =
        verdict === 'unheard' ? null : await service.submitAnswer(actorUserId, sessionId, input.questionId, answer, { retry });
      return { heard, verdict, session };
    },

    /**
     * Phase 41 (spec D2). A typed answer through next-step. With `checkFit`, a
     * first answer to a typed cloze that the rule calls wrong is shown to the
     * model, which says whether it fills the gap: a word that fits is recorded
     * as one of the card's alternatives. The card is checked first, so no call
     * is spent on a replay, a retry, a listed word, an empty text or the wrong
     * alphabet; the call is made outside any transaction (ADR 0001 R8); and a
     * failed call leaves the rule's verdict (ruling R2). Then it is recorded
     * through submitAnswer, exactly as any next-step is.
     */
    answerText: async (
      actorUserId: string,
      sessionId: string,
      input: { questionId: string; text: string; hintOpened?: boolean; helped?: boolean; checkFit?: boolean; retry?: boolean },
    ): Promise<SessionResult> => {
      const retry = input.retry ?? false;
      const card =
        // Phase 56 (spec D4): a helped answer is a miss whatever the model says, so it is not asked.
        input.checkFit && !retry && !input.helped
          ? await transaction(async (repos) => {
              const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
              const loaded = await repos.session.loadSession(sessionId);
              if (!loaded || (loaded.status !== 'ready' && loaded.status !== 'completed')) return null;
              const attempt = attemptOf(loaded, input.questionId, false);
              if (attempt.kind !== 'answer' || attempt.question.type !== 'cloze_typed' || input.text.trim() === '') return null;
              const language = enrolled.target_language as LanguageCode;
              const expected = gatesScript(attempt.question, language, enrolled.source_language as LanguageCode);
              if (expected !== null && wrongScript(input.text, expected)) return null;
              // Phase 47 (spec D3): the record's handles travel with the card.
              const record: ModelCallRecord = { kind: 'fit_judge', sessionId, enrollmentId: enrolled.id, userId: enrolled.user_id };
              return evaluate(attempt.question, { text: input.text }).verdict === 'wrong' ? { question: attempt.question, language, record } : null;
            })
          : null;
      let fits = false;
      if (card) {
        const started = now();
        try {
          const verdict = parseFitJudge(await judge({ ...buildFitJudgePrompt(card.question, card.language, input.text), record: card.record }));
          if (verdict === null) throw new LlmUnavailable('the verdict was unreadable');
          fits = verdict === 'fits';
          logger.info({ event: 'answer_fit_checked', session_id: sessionId, question_type: 'cloze_typed', verdict, judge_ms: now() - started, chars: input.text.length });
        } catch (error) {
          logger.info({
            event: 'answer_fit_check_failed',
            session_id: sessionId,
            question_type: 'cloze_typed',
            judge_ms: now() - started,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Phase 55 (spec D6). `helped` travels with the text, so `step` grades a helped
      // tiles or typed answer wrong, first try or second.
      const answer = input.helped === undefined ? { text: input.text } : { text: input.text, helped: input.helped };
      return service.submitAnswer(actorUserId, sessionId, input.questionId, answer, { retry, hintOpened: input.hintOpened, fits });
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
      input: { questionId: string; text: string; retry?: boolean; helped?: boolean; tapped?: readonly number[] },
    ): Promise<JudgedResult> => {
      const retry = input.retry ?? false;
      type Checked =
        | { replay: JudgedResult }
        | { current: JudgedQuestion; context: JudgeContext; owner: { enrollmentId: string; userId: string } };
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
        return {
          current,
          context: { language: enrolled.target_language as LanguageCode, explanation: enrolled.source_language as LanguageCode, ...found },
          owner: { enrollmentId: enrolled.id, userId: enrolled.user_id },
        };
      });
      if ('replay' in checked) return checked.replay;

      const text = input.text.slice(0, MAX_JUDGED_TEXT);
      // Phase 39 (spec D10). Before the rule and the judge, so no model is called
      // for an answer in the wrong alphabet, and nothing is recorded. The gate is
      // `step`'s, so a card whose own answer is in another alphabet is not checked.
      const expected = gatesScript(checked.current, checked.context.language, checked.context.explanation);
      if (expected !== null && wrongScript(text, expected)) {
        logger.info({ event: 'answer_wrong_script', session_id: sessionId, question_type: checked.current.type });
        throw new WrongScript(input.questionId, LANGUAGES[expected].name);
      }
      let verdict = ruleVerdict(checked.current, text, checked.context.alternatives);
      const judgedBy = verdict === null ? 'model' : 'rule';
      const started = now();
      if (verdict === null) {
        try {
          const translating = checked.current.type === 'sentence_translation';
          const client = translating ? translationJudge : judge;
          const raw = await client({
            ...judgePrompt(checked.current, checked.context, text),
            record: { kind: translating ? 'translation_judge' : 'judge', sessionId, ...checked.owner },
          });
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
        // Phase 56 (spec D4): stored wrong, whatever the verdict.
        ...(input.helped ? { helped: true } : {}),
      });
      const answer = input.helped === undefined ? { text, judged: verdict } : { text, judged: verdict, helped: input.helped };
      const session = await service.submitAnswer(actorUserId, sessionId, input.questionId, answer, { retry, tapped: input.tapped });
      // Phase 56 (spec D3). A helped answer is stored wrong, and the app tells
      // "right, with help" by the judge's own verdict, so that is the one reported.
      if (input.helped) return { verdict, session };
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
    prepareSession: async (data: unknown, job: { attempt?: number } = {}): Promise<void> => {
      const payload = PrepareSessionPayloadSchema.parse(data);
      const sessionId = payload.session_id;
      // Phase 55 (spec D4, ruled). A payload the code before this deploy chose may hold three
      // ladders (phase 54's three slots each). Planned in the new shape, its forms without tiles
      // each add an intro typed card, and it could ask the model more items than the batch
      // takes (LlmDistractorsSchema, ten), failing the session. The first NEW_PER_SESSION ladder
      // picks are kept, in pick order, and the rest dropped: asked as a plain pick, a word never
      // met would be asked cold.
      let ladders = 0;
      const picks = payload.picks.filter((pick) => !pick.ladder || ++ladders <= NEW_PER_SESSION);

      const read = await transaction(async ({ session, enrollment, question, gloss, dict, jobs, memory }) => {
        const state = await session.findState(sessionId);
        // Skipped, or gone (a reseed): nothing to prepare, and not a failure.
        if (!state || state.status !== 'preparing') return undefined;
        const enrolled = await enrollment.findById(state.enrollmentId);
        if (!enrolled) return undefined;
        // Phase 31 (spec D14). A pick made before a merge names the survivor now,
        // and a gloss of another learner language is refused.
        const resolved = await gloss.resolveGlosses(picks.map((pick) => pick.gloss_id));
        const foreign = picks.find(
          (pick) => (resolved.get(pick.gloss_id)?.userLanguageCode ?? enrolled.source_language) !== enrolled.source_language,
        );
        if (foreign) throw new GlossLanguageMismatch(foreign.gloss_id);
        const asked = picks.map((pick) => ({
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
        // Phase 59 (spec D1). The list's practised words, which a translation
        // sentence is built from as much as it can, keyed as the prompts name them.
        // Final review: never a word this session asks, whose card the reference would answer.
        const asking = new Set(formed.map((row) => row.glossId));
        const practised = await memory.findPractisedWords({ enrollmentId: state.enrollmentId, limit: MAX_LEARNER_WORDS });
        const learnerWords: LearnerWord[] = practised
          .filter((word) => !asking.has(word.glossId))
          .map((word, index) => ({ key: `w${index + 1}`, ...word }));
        return { state, enrolled, context: formed, picked: context.map(pickOf), recent, recentContexts, siblings, known, learnerWords };
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
      // Phase 47 (spec D3, D6). The handles of this attempt's three calls.
      const record = (kind: ModelCallRecord['kind']): ModelCallRecord => ({
        kind,
        sessionId,
        attempt: job.attempt,
        enrollmentId: read.enrolled.id,
        userId: read.enrolled.user_id,
      });
      const plan = planCards(
        read.context.map((row, index) => {
          const { dimension, rung, level, r, step, known_meanings, ladder } = read.picked[index];
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
            // Phase 39 (spec D6): a pick with them is a new_meaning card.
            knownMeanings: known_meanings,
            // Phase 54 (spec D3, D7): a ladder pick is its four cards; a pick stored without the flag is none.
            ladder: ladder ?? false,
          };
        }),
        // Phase 57 (ruling T3-l): a target path's session plans its picks with no MAX_PER_TYPE and
        // no one-word speaking rule, so no pick falls back to a card that serves no owed work.
        { listening: payload.listening, speaking: payload.speaking, target: payload.target ?? false },
      );
      const ordered = plan.order.map((index) => read.context[index]);
      const tasks = tasksFor({ ...plan, types: plan.types.map(generatedAs) });
      const items = distractorItems(ordered, tasks, read.recent);
      // Phase 31 (spec D18). Another headword with this card's key is right where
      // the card asks for this one: off limits as a wrong option, and named to the
      // model with the session's other rows, so it never offers one the
      // validator would refuse on every retry.
      const siblingsOf = (glossId: string) =>
        read.siblings.filter((sibling) => sibling.glossId === glossId).map((sibling) => sibling.lemma);
      // Phase 54 (spec D7): a ladder's row sits at four positions, and is named once.
      const rows = [...new Set(ordered)];
      const siblingRows = rows.flatMap((row) => siblingsOf(row.glossId).map((lemma) => ({ form: lemma, translation: row.translation })));
      // The rows that ask the model nothing are still in the session: the
      // validation and the prompt must know their words and meanings. Phase 54
      // (spec D7): a meet card's row is not another word: its practice cards are items.
      const itemRows = new Set(ordered.filter((_, index) => tasks[index]));
      const others = [...rows.filter((row) => !itemRows.has(row)), ...siblingRows];
      // Where each pick's form sits in its saved example: the same search that
      // made the gap item's blank and the plan's eligibility.
      const gaps = ordered.map((row) => findGap(row.example ?? '', [row.form, row.lemma]));

      const started = now();
      let modelMs = 0;
      let verdict: DistractorVerdict;
      const board = plan.board;
      try {
        const raw = await llm({
          ...buildDistractorPrompt({ items, from: target, to: read.enrolled.source_language, others, learnerWords: read.learnerWords }),
          record: record('session_generation'),
        });
        modelMs = now() - started;
        // An empty string is the provider's "no content" (a safety block). Here,
        // unlike a lookup, there is nothing useful to serve without it.
        const answer = raw === '' ? null : parseLlmDistractors(raw);
        if (!answer) throw new InvalidDistractors(sessionId, 'the model answer was unreadable');
        // Phase 34 (spec D3, D4): the first three usable of six, none known right.
        // Phase 48 (spec D1): a card with fewer is refused, not the batch.
        verdict = validateDistractors(items, answer, read.enrolled.source_language, others, target, read.known);
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

      // Phase 48 (spec D1, D2). Why each refused card was refused, by plan index.
      const refusals = new Map<number, Refusal>();
      ordered.forEach((_, index) => {
        const reason = verdict.refused.get(keyOf(index));
        if (reason) refusals.set(index, { stage: 'validation', reason });
      });
      const refuseBoard = (refusal: Refusal) => {
        for (let offset = 0; offset < BOARD_SIZE; offset += 1) refusals.set(board!.start + offset, refusal);
      };
      // Spec D10: a board with no usable fifth meaning is refused here, before
      // the context call and the checker are paid for; the checker can only take
      // more away (below). Phase 48 (ruling R2): the board is refused whole.
      if (board) {
        const own = refusals.get(board.start);
        const first = verdict.byKey.get(keyOf(board.start));
        if (own) refuseBoard(own);
        else if (!boardMeanings(ordered.slice(board.start, board.start + BOARD_SIZE), ordered, [...first!.distractors, ...first!.spares], read.known)) {
          refuseBoard({ stage: 'validation', reason: "every wrong meaning of the board is one of its words' own" });
        }
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
        // Phase 48 (spec D1): nothing a refused card would show is known to be good.
        if (refusals.has(card.index)) continue;
        const item = contextItemFor({
          key: keyOf(card.index),
          type: generatedAs(card.type),
          row: card.row,
          alternatives: card.answered.alternatives,
          // Phase 39 (spec D6): findRecentContexts files a new_meaning's under multiple_choice.
          recent: read.recentContexts.get(card.row.glossId)?.[generatedAs(card.type)] ?? [],
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
          const raw = await contextLlm({
            ...buildContextPrompt({ items: [...contextItems.values()], from: target, to: read.enrolled.source_language, learnerWords: read.learnerWords }),
            record: record('context'),
          });
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

      // Logged once the session is written, not on an attempt a failed insert or a
      // retry repeats. Phase 48 (spec D6, ruling R5): each names its card by plan
      // index here, and is logged with the position the card was written to.
      const events: { index: number; [field: string]: unknown }[] = [];
      const shown = cards.map((card) => {
        const item = contextItems.get(card.index);
        let context: StoredContext | null = null;
        // Phase 34 (spec D5): only a sentence the model wrote is the checker's to read.
        let checkable: BareContextItem | null = null;
        let sentence: { text: string; mark: Mark | null } | null = null;
        // Phase 59 (spec D2). A translation card's word map, never its refusal.
        let words: MapWord[] | null = null;
        if (item?.task === 'mark') {
          sentence = { text: item.sentence, mark: contextAnswer ? markFor(item, found.get(item.key)) : null };
          if (contextAnswer) words = wordMapFor(item, found.get(item.key), sentence.mark, read.learnerWords, card.row.glossId);
        } else if (item) {
          if (contextAnswer) {
            const outcome = resolveContext(item, found.get(item.key), languages);
            context = outcome.context;
            if (outcome.dropped) {
              events.push({ event: 'context_dropped', session_id: sessionId, index: card.index, type: card.type, reason: outcome.dropped });
            } else {
              checkable = item;
            }
          } else {
            context = fallbackContext(card.row, item.task);
          }
        }
        return { ...card, context, checkable, sentence, words };
      });

      // Phase 34 (spec D5). The checker: a second model reads the cards as a
      // learner would, with no transaction open (ADR 0001 R8). Every usable
      // wrong option of a choice card, spares included, so a "yes" can be
      // replaced; the board's candidates for its fifth meaning against each of
      // its four words; each sentence the context call wrote; each sentence
      // card's Hebrew. Unlike the context call, an unreadable or failed answer
      // fails the attempt, as an unreadable batch does, and pg-boss retries it.
      // At most six (ASKED_DISTRACTORS), as validateDistractors keeps them: the
      // checker numbers every option, and a miscount refuses its card (phase 48,
      // ruling R3). A card validation refused is asked nothing (phase 48, spec D1).
      const candidatesOf = (index: number): string[] => {
        const made = verdict.byKey.get(keyOf(index));
        return made ? [...made.distractors, ...made.spares].slice(0, ASKED_DISTRACTORS) : [];
      };
      const boardCandidates = board && !refusals.has(board.start) ? candidatesOf(board.start) : [];
      const glossMeanings = (row: GenerationContext) => [row.translation, ...(read.known.meaningsByGloss.get(row.glossId) ?? [])];
      const checkItems: CheckItem[] = [];
      for (const card of shown) {
        if (refusals.has(card.index)) continue;
        const key = keyOf(card.index);
        const { row } = card;
        const type = generatedAs(card.type);
        if (type === 'multiple_choice' || type === 'listen_choice') {
          checkItems.push({ key, task: 'choice', word: row.answerForm ?? row.form, options: candidatesOf(card.index) });
        } else if (type === 'reverse_choice') {
          checkItems.push({ key, task: 'choice', word: row.translation, options: candidatesOf(card.index) });
        } else if (type === 'cloze_choice') {
          const gap = gaps[card.index]!;
          const sentence = `${row.example!.slice(0, gap.start)}___${row.example!.slice(gap.end)}`;
          checkItems.push({ key, task: 'gap', sentence, options: candidatesOf(card.index) });
        } else if (type === 'matching' && boardCandidates.length > 0) {
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
        if ((type === 'cloze_typed' || type === 'sentence_translation') && hebrew) {
          checkItems.push({ key, task: 'translate', sentence: hebrew });
        }
      }

      const checkerStarted = now();
      let checkerMs = 0;
      let findings = new Map<string, CheckFinding>();
      // Phase 48 (spec D2, ruling R3): a choice or gap item the checker left unnumbered, with why.
      let unjudged = new Map<string, string>();
      let meanings: string[] | null = null;
      const survivors = new Map<number, string[]>();
      const alsoRight = (key: string): boolean[] => {
        const finding = findings.get(key);
        return finding && (finding.task === 'choice' || finding.task === 'gap') ? finding.alsoRight : [];
      };
      try {
        if (checkItems.length > 0) {
          const raw = await checkerLlm({ ...buildCheckPrompt(checkItems, target, read.enrolled.source_language), record: record('checker') });
          checkerMs = now() - checkerStarted;
          const answer = raw === '' ? null : parseCheck(raw);
          if (!answer) {
            throw new InvalidDistractors(sessionId, raw === '' ? 'the checker returned no content' : 'the checker answer was unreadable');
          }
          const reading = readCheck(checkItems, answer);
          findings = reading.byKey;
          unjudged = reading.unjudged;
        }
        // Spec D4: a "yes" drops the option and the next spare takes its place.
        // Phase 48 (spec D2): fewer than three left refuses the card, as fewer
        // than three usable does, and so does a miscount.
        for (const card of shown) {
          if (!CHOSEN.has(generatedAs(card.type)) || refusals.has(card.index)) continue;
          const key = keyOf(card.index);
          const notJudged = unjudged.get(key);
          if (notJudged) {
            refusals.set(card.index, { stage: 'checker', reason: notJudged });
            continue;
          }
          const left = wrongOnly(candidatesOf(card.index), alsoRight(key));
          if (left.length < KEPT_DISTRACTORS) {
            refusals.set(card.index, {
              stage: 'checker',
              reason: `the checker calls ${candidatesOf(card.index).length - left.length} of ${key}'s ${candidatesOf(card.index).length} wrong options right, and ${KEPT_DISTRACTORS} must be left`,
            });
            continue;
          }
          survivors.set(card.index, left);
        }
        // Spec D10, phase 34 (D3, D5): the board's fifth meaning is the first of its
        // first word's usable wrong meanings that no board word's own meaning, nor
        // what the dictionary knows of the four, nor the checker for any of them,
        // makes right. Phase 48 (spec D2, ruling R2): none, or a board word the
        // checker miscounted, refuses the board whole.
        if (board && !refusals.has(board.start)) {
          const keys = Array.from({ length: BOARD_SIZE }, (_, offset) => keyOf(board.start + offset));
          const notJudged = keys.map((key) => unjudged.get(key)).find((reason) => reason !== undefined);
          const rightForOne = new Set(keys.map(alsoRight).flatMap((flags) => boardCandidates.filter((_, at) => flags[at])));
          meanings = notJudged
            ? null
            : boardMeanings(ordered.slice(board.start, board.start + BOARD_SIZE), ordered, boardCandidates.filter((text) => !rightForOne.has(text)), read.known);
          if (!meanings) {
            refuseBoard({ stage: 'checker', reason: notJudged ?? "every wrong meaning of the board is one of its words' own" });
          } else {
            for (const text of rightForOne) {
              events.push({ event: 'checker_dropped', session_id: sessionId, index: board.start, type: 'matching', kind: 'option', text, reason: 'the checker calls it right for a board word' });
            }
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

      // Phase 48 (spec D3). Which cards the session keeps: every unit nobody
      // refused, and refused ones while it would hold fewer than six. The board
      // is one unit (ruling R2). `rng` is drawn only for a fill.
      const units: CardUnit[] = [];
      for (let index = 0; index < ordered.length; ) {
        const size = board && index === board.start ? BOARD_SIZE : 1;
        units.push({ indexes: Array.from({ length: size }, (_, offset) => index + offset), refusal: refusals.get(index) ?? null });
        index += size;
      }
      // Phase 54 (spec D7). A meet card is never refused, and never the only card
      // of its word: one whose practice cards were all dropped goes with them.
      const fateOf = new Map(
        dropLoneMeets(keepCards(units, rng), (index) => ordered[index].glossId, (index) => plan.types[index]).map((fate) => [fate.index, fate]),
      );
      for (const fate of fateOf.values()) {
        if (fate.fate !== 'keep_refused' || fate.shownAs !== 'as_generated' || !CHOSEN.has(generatedAs(plan.types[fate.index]))) continue;
        // An ambiguous card, Victor's call: the survivors first, then the
        // options the checker called right, each in the model's order.
        const all = candidatesOf(fate.index);
        const right = alsoRight(keyOf(fate.index));
        survivors.set(fate.index, [...all.filter((_, at) => !right[at]), ...all.filter((_, at) => right[at])]);
      }
      if (board && fateOf.get(board.start)?.fate === 'keep_refused' && refusals.get(board.start)?.stage === 'checker') {
        // The fifth meaning validation chose, without the checker's filter.
        meanings = boardMeanings(ordered.slice(board.start, board.start + BOARD_SIZE), ordered, boardCandidates, read.known);
      }

      // What the checker's answer does to each card: its three wrong options, its
      // context (D6's fallback when the checker reads another sense), and a
      // sentence card the practised word is not natural in (phase 27's degraded
      // path: a typed translation, D8).
      const final = shown.map((card) => {
        const key = keyOf(card.index);
        const { row } = card;
        let { type, answered, context, sentence, degradedReason } = card;
        const fate = fateOf.get(card.index)!;
        if (fate.fate === 'keep_refused' && fate.shownAs === 'typed_translation') {
          // Phase 48 (spec D3, ruling R1): no three showable options, so phase
          // 27's degraded card, built as the checker's degraded sentence card is.
          type = 'typed_translation';
          answered = typedAnswered(row, NOTHING_GENERATED);
          sentence = null;
          context = fallbackContext(row, 'explanation');
        }
        const left = survivors.get(card.index);
        if (left) {
          for (const text of candidatesOf(card.index).filter((option) => !left.includes(option))) {
            events.push({ event: 'checker_dropped', session_id: sessionId, index: card.index, type, kind: 'option', text, reason: 'the checker calls it right' });
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
            events.push({ event: 'checker_dropped', session_id: sessionId, index: card.index, type, kind: 'context', text: context.text, reason: `the checker reads it as ${reading || 'nothing'}` });
            context = fallbackContext(row, card.checkable.task);
          }
        }
        const sentenceFinding = findings.get(key);
        const made = sentenceOf(answered);
        if (sentenceFinding?.task === 'translate' && made) {
          const practised = [made.word, row.form, row.lemma, ...(row.answerForm ? [row.answerForm] : []), ...row.acceptedAnswers, ...answered.alternatives];
          if (!translationUses(sentenceFinding.translation, practised)) {
            const reason = `the checker says it "${sentenceFinding.translation}", using neither ${made.word} nor an answer the card accepts`;
            events.push({ event: 'checker_dropped', session_id: sessionId, index: card.index, type, kind: 'sentence', text: made.hebrew, reason });
            type = 'typed_translation';
            answered = typedAnswered(row, NOTHING_GENERATED);
            degradedReason = reason;
            sentence = null;
            context = fallbackContext(row, 'explanation');
          }
        }
        if (degradedReason !== null) {
          events.push({ event: 'sentence_degraded', session_id: sessionId, index: card.index, type: card.planned, reason: degradedReason });
        }
        // Spec D6: a sense saved without an example has nothing to fall back on.
        if (!context && contextLanguageOf(generatedAs(type)) !== null) {
          events.push({ event: 'context_missing', session_id: sessionId, index: card.index, type });
        }
        return { row, index: card.index, type, answered, context, sentence, words: card.words };
      });
      // Phase 48 (spec D4). The plan's order, a dropped card's place closed up:
      // a card's written position is its place here, while `index` stays its
      // plan index for everything that indexes the plan.
      const kept = final.filter((card) => fateOf.get(card.index)!.fate !== 'drop');

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
          questions: kept.map(({ row, index, type, answered, context, sentence, words }) => ({
            glossId: survivorGlosses.get(row.glossId)?.id ?? row.glossId,
            variantId: row.variantId,
            form: row.form,
            lemma: row.lemma,
            partOfSpeech: row.partOfSpeech,
            lexemeId: row.lexemeId,
            type,
            ...generatedContent(row, generatedAs(type), answered, {
              tiles: type === 'letter_tiles' ? tilesFor(row.answerForm ?? row.form, LANGUAGES[target].alphabet, rng) : null,
              board: type === 'matching' && board && meanings ? { meanings, own: index - board.start } : null,
              gap: gaps[index],
            }),
            // Phase 34 (spec D6, D8, D12): stored as shown.
            ...contextColumns(generatedAs(type), context, sentence),
            // Phase 39 (spec D6): what a new_meaning lists as known, from its pick.
            knownMeanings: type === 'new_meaning' ? (read.picked[plan.order[index]].known_meanings ?? null) : null,
            // Phase 55 (spec D2, as ruled): a card of a ladder's intro stage, by its plan index, which
            // goes with the card past a dropped one; its answer writes no memory and no progress.
            intro: plan.intro[index],
            // Phase 59 (spec D2): a card degraded from a sentence translation keeps none.
            words: type === 'sentence_translation' ? words : null,
          })),
        });
        // Each choice shuffled on its own, a board's words once together; the
        // question order is the plan's and is not shuffled.
        await session.insertSessionQuestions(sessionId, shuffleSession(generated, rng));
        return true;
      });

      if (written) {
        // Phase 48 (spec D6, ruling R5). A card's events, at the position it was
        // written to, with the plan's key that model_calls knows it by; a dropped
        // card's, never.
        const writtenAt = new Map(kept.map((card, position) => [card.index, position]));
        for (const { index, ...event } of events) {
          const position = writtenAt.get(index);
          if (position !== undefined) logger.info({ ...event, key: keyOf(index), position });
        }
        for (const fate of fateOf.values()) {
          if (fate.fate === 'keep') continue;
          const base = { session_id: sessionId, key: keyOf(fate.index), type: plan.types[fate.index], stage: fate.refusal.stage, reason: fate.refusal.reason };
          logger.info(
            fate.fate === 'drop'
              ? { event: 'card_dropped', ...base }
              : { event: 'card_kept_refused', ...base, position: writtenAt.get(fate.index), shown_as: fate.shownAs },
          );
        }
      }
      logger.info({
        event: written ? 'session_prepared' : 'session_preparation_dropped',
        session_id: sessionId,
        // Phase 48 (spec D6): the questions written, of the cards planned.
        question_count: written ? kept.length : 0,
        planned_count: ordered.length,
        dropped_count: [...fateOf.values()].filter((fate) => fate.fate === 'drop').length,
        item_count: items.length,
        model_ms: modelMs,
        context_ms: contextMs,
        check_count: checkItems.length,
        checker_ms: checkerMs,
        ...(written ? {} : { stage: 'write' }),
      });
    },

    /**
     * Phase 43 (spec D3). The stock job: builds a path's next session in stock (phase 57,
     * spec D2: the main path's, or the target's the payload names) when it has none, the
     * enrollment has had a session (else the seed, the main path's, comes next; a target's
     * path never waits for it), its target is still active, and it has words to ask. Anything
     * else is a no-op, logged with why; so is a race lost to another stock. Built for the
     * start's device when the trigger was a start, else the newest session's (ruling R2).
     */
    stockSession: async (data: unknown): Promise<void> => {
      const payload = StockSessionPayloadSchema.parse(data);
      const enrollmentId = payload.enrollment_id;
      const path = payload.target_id ?? null;
      type Outcome = Stocked | { why: 'no_enrollment' | 'stocked' | 'seed_next' | 'no_saved_words' | 'target_closed' };
      let outcome: Outcome;
      try {
        outcome = await transaction(async (repos): Promise<Outcome> => {
          const enrolled = await repos.enrollment.findById(enrollmentId);
          if (!enrolled) return { why: 'no_enrollment' };
          // Review C1. A create running now finishes first, and its stock is seen.
          await repos.session.lockNextSession(enrollmentId, path);
          if ((await repos.session.findOpen(enrollmentId, path)).stock) return { why: 'stocked' };
          if (path === null && !(await repos.session.findLatest(enrollmentId, 'any'))) return { why: 'seed_next' };
          if (path !== null) {
            const target = await repos.target.findTarget(path);
            const today = await learnerDay(repos, enrolled.user_id, now());
            if (!target || target.enrollmentId !== enrollmentId || !activeOn(target, today)) return { why: 'target_closed' };
          }
          const devices =
            payload.listening !== undefined && payload.speaking !== undefined
              ? { listening: payload.listening, speaking: payload.speaking }
              : ((await repos.session.findNewestDevices(enrollmentId)) ?? { listening: false, speaking: false });
          return stockNext(repos, enrolled, devices, path);
        });
      } catch (error) {
        if (error instanceof SessionOpen) outcome = { why: 'stocked' };
        else if (error instanceof NoSavedWords) outcome = { why: 'no_saved_words' };
        else throw error;
      }
      if ('sessionId' in outcome) logStocked(enrollmentId, outcome, payload.reason);
      else {
        logger.info({
          event: 'session_stock_skipped',
          enrollment_id: enrollmentId,
          reason: payload.reason,
          why: outcome.why,
          ...(path === null ? {} : { target_id: path }),
        });
      }
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

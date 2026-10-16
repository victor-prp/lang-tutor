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
import { liveDimensions } from '../domain/choose';
import { NEW_PER_SESSION } from '../domain/chooseConstants';
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
import { applySession } from '../domain/memoryUpdate';
import { evaluateSession, progressChanges, type ProgressChange } from '../domain/progress';
import type { Devices, SessionRecord, SessionSummary } from '../domain/session';
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
import type { Mark } from '../domain/marks';
import { buildSoundAlikePrompt, orderedPair, parseSoundAlike, type OrderedPair } from '../domain/soundAlike';
import { MIN_AUDIO_CHARS, parseTranscript, transcriptionSystem } from '../domain/speech';
import { chooseWithTargets, splitChanged, targetSplit, type TargetSessionInput, type TargetSplit } from '../domain/targetSession';
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
  WrongScript,
} from '../errors';
import type { Logger } from '../logger';
import { authorizeEnrollment } from './access';
import { learnerDay } from './learnerDay';
import type { LlmClient, ModelCallRecord } from './llm';
import type { SpeechTranscriber } from './speech';
import { requestStock } from './stock';
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

/** Phase 53 (spec D8). A stock written: its session, and the targets its choice found ended
 *  on their date, whose events name it. Logged once its transaction commits. */
type Stocked = { sessionId: string; endedOnDate: string[] };

/** Phase 53 (ruling R-D12). A stale stock retired, and the stock built in its place. */
type Replaced = Stocked & { retired: string };

/** Phase 53 (ruling R-D12). What the cheap half of the stale check read of one stock: the
 *  learner's today, the devices the stock was built for, and the split it recorded. */
type MaybeStale = { stockId: string; today: string; devices: Devices; recorded: TargetSplit[] };

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
   * Phase 53 (spec D6, D7, D12). What a stock's words are chosen from, read on the owner's
   * learner day: the picker's input, with the targets active that day, and the families the
   * choice refreshes. Null when the list is empty, before anything else is read. A stock and
   * the stale check both read through here, so the split the check compares is the split a
   * stock built now would record.
   */
  async function readChoice(repos: Repos, enrolled: Enrollment, devices: Devices) {
    const { session, vocabulary, dict } = repos;
    const enrollmentId = enrolled.id;
    const saved = await vocabulary.listSavedGlosses(enrollmentId);
    if (saved.length === 0) return null;
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
    // memory with the session's live skills. Phase 46 (spec D3): known_at is the
    // gloss's own, family or not.
    const forms = await dict.findLexemeForms({ lexemeIds: [...new Set(saved.map((gloss) => gloss.lexemeId))] });
    const formsOf = new Map<string, string[]>();
    for (const row of forms) formsOf.set(row.lexemeId, [...(formsOf.get(row.lexemeId) ?? []), row.form]);
    const stored = await repos.glossFamilies.load(enrollmentId);
    const members = saved.map((gloss) => ({
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
    const families = glossFamilies({ saved: members, memory, live: liveDimensions(devices.listening, devices.speaking) });
    const waiting = new Set([...families.state].filter(([, state]) => state === 'waiting').map(([glossId]) => glossId));
    // Phase 37 (spec D1, D7). Today's answers leave the returns owed and the
    // words done for the day.
    const introduced = await session.findIntroducedOn(enrollmentId, today);
    // Phase 43 (spec D4). Picked beside the started session, whose saved
    // glosses count as answered today: the two ask different words while the
    // list has others, and its first meetings are today's new words too.
    const { started } = await session.findOpen(enrollmentId);
    const inFlight = started ? (await session.findSessionGlosses(started.id)).filter((glossId) => glossIds.includes(glossId)) : [];
    const met = new Set([...memory.map((row) => row.glossId), ...introduced]);
    const { steps, done, extraNew } = withSessionInFlight(
      dayState(await session.findAnswersOn(enrollmentId, today), new Set(introduced)),
      inFlight,
      met,
    );
    // Phase 53 (spec D1, D7, ruling R-D4). The targets active on the day; whether each word
    // can be said, as the families read it; and the words first met on the day, the session
    // in flight's first meetings (extraNew's) among them.
    const input: TargetSessionInput = {
      choice: {
        saved,
        memory,
        levels,
        today,
        steps,
        done,
        newToday: introduced.length + extraNew,
        listening: devices.listening,
        speaking: devices.speaking,
        rng,
        // Phase 54 (spec D2): a family's introduction keeps its new_meaning card, no ladder.
        families: { familyOf: families.familyOf, waiting, introductions: new Set(families.introductions.keys()) },
      },
      targets: await repos.target.listActive(enrollmentId, today),
      speakable: new Map(members.map((member) => [member.glossId, member.speakable])),
      introducedToday: new Set([...introduced, ...inFlight.filter((glossId) => !met.has(glossId))]),
    };
    return { at, today, saved, families, stored, input };
  }
  type ChoiceRead = NonNullable<Awaited<ReturnType<typeof readChoice>>>;

  /**
   * Phase 53 (spec D6, D8). A stock's words, chosen from `read`: the picks its preparation is
   * given, in the order chosen, and the split they were chosen with. Null when no chosen
   * gloss has a rendering to ask.
   */
  async function choosePicks(repos: Repos, enrolled: Enrollment, read: ChoiceRead) {
    const { picks: chosen, split } = chooseWithTargets(read.input);
    // Phase 31 (spec D12). One rendering per gloss, uniformly over every form of
    // every member that agrees with the gloss, the saved form always among them.
    // No model call: a lemma form not yet rendered joins once its job lands.
    const renderings = await repos.dict.findGlossRenderings({
      glossIds: chosen.map((choice) => choice.glossId),
      userLanguageCode: enrolled.source_language,
    });
    const savedById = new Map(read.saved.map((gloss) => [gloss.glossId, gloss]));
    const picks = chosen.flatMap((choice) => {
      const rendering = pickRendering(askableRenderings(savedById.get(choice.glossId)!, renderings), rng);
      if (!rendering) return [];
      const { dimension, rung, level, r, ladder } = choice;
      const step = choice.cls === 'STEP';
      // Phase 39 (spec D6). A family's next meaning, never asked, is introduced with the known ones.
      const knownMeanings = read.families.introductions.get(choice.glossId);
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
    return picks.length === 0 ? null : { picks, split };
  }
  type ChosenStock = NonNullable<Awaited<ReturnType<typeof choosePicks>>>;

  /**
   * Phase 43 (spec D3). A stock chosen from `read`, written: the session inserted preparing
   * for `devices`, the families' refresh, and its preparation enqueued in the same
   * transaction, so the row and its job commit together. Phase 53 (spec D8, D12): the
   * session records the learner day its words were chosen on and the split they were chosen
   * with, and each target whose date has come is recorded as ended on it, naming the session.
   */
  async function writeStock(repos: Repos, enrolled: Enrollment, devices: Devices, read: ChoiceRead, chosen: ChosenStock): Promise<Stocked> {
    const { session, vocabulary, jobs } = repos;
    const enrollmentId = enrolled.id;
    const { at, today, families, stored } = read;
    const sessionId = await session.insertPreparingSession(enrolled.user_id, enrollmentId, devices, today);
    if (chosen.split.length > 0) await repos.target.insertSessionSplit(sessionId, chosen.split);
    // Phase 53 (spec D8). A target ends on its date by itself; the first stock chosen from
    // that day on writes its ended_on_date.
    const endedOnDate = await repos.target.listEndedUnrecorded(enrollmentId, today);
    for (const target of endedOnDate) {
      await repos.target.insertEvent({
        targetId: target.id,
        kind: 'ended_on_date',
        before: null,
        after: { due_on: target.dueOn },
        actorUserId: null,
        sessionId,
      });
    }
    // Phase 39 (spec D4). The refresh is recorded once the session exists, so
    // each event names it; one that changed nothing writes nothing. Phase 46
    // (spec D3): every gloss known for the first time is stamped, family or not.
    if (families.newlyKnown.size > 0) {
      await vocabulary.markKnown({ enrollmentId, glossIds: [...families.newlyKnown], at: new Date(at).toISOString() });
    }
    const write = familyChanges(stored, families);
    if (!isEmptyFamilyWrite(write)) await repos.glossFamilies.apply(enrollmentId, sessionId, write);
    await jobs.enqueue(PREPARE_SESSION, {
      session_id: sessionId,
      picks: chosen.picks,
      listening: devices.listening,
      speaking: devices.speaking,
    });
    return { sessionId, endedOnDate: endedOnDate.map((target) => target.id) };
  }

  /**
   * Phase 43 (spec D3). Phase 19's list branch of create, shared by create and
   * the stock job: the words read and chosen, then written. NoSavedWords when
   * the list has nothing to ask. Phase 53 (spec D6): the words serve the
   * targets active on the learner day.
   */
  async function stockNext(repos: Repos, enrolled: Enrollment, devices: Devices): Promise<Stocked> {
    const read = await readChoice(repos, enrolled, devices);
    const chosen = read ? await choosePicks(repos, enrolled, read) : null;
    if (!read || !chosen) throw new NoSavedWords(enrolled.id);
    return writeStock(repos, enrolled, devices, read, chosen);
  }

  /**
   * Phase 53 (ruling R-D12). The cheap half of the stale check: a list stock whose words were
   * chosen on an earlier learner day than today, and which recorded a split or has a target
   * active today beside it. A seed, a stock from before phase 53 (no chosen_on) and today's
   * never are, and with no target on either side phase 43 R5 holds without the list being
   * read (final review item 16: the home read takes no lock for it). Answers what it read, or
   * null. `stock` is unstarted: findOpen's.
   */
  async function mayBeStale(repos: Repos, enrolled: Enrollment, stock: SessionSummary): Promise<MaybeStale | null> {
    if (stock.source !== 'list') return null;
    const choice = await repos.session.findStockChoice(stock.id);
    if (!choice || choice.chosenOn === null) return null;
    const today = await learnerDay(repos, enrolled.user_id, now());
    if (choice.chosenOn >= today) return null;
    const recorded = await repos.target.findSessionSplit(stock.id);
    if (recorded.length === 0 && (await repos.target.listActive(enrolled.id, today)).length === 0) return null;
    return { stockId: stock.id, today, devices: { listening: choice.listening, speaking: choice.speaking }, recorded };
  }

  /**
   * Phase 53 (spec D12, ruling R-D12). A stock chosen on an earlier learner day is played as
   * it is (phase 43 R5) unless today's split differs from the one it recorded: then it is
   * retired and the next is built in its place, for the devices it was built for. A list
   * with nothing to ask, or chosen words with no rendering, leave the stock as it is, and so
   * does a start that took it first. The caller holds lockNextSession and read `stock` under
   * it. `checked` is mayBeStale's answer from before the lock: a stock's day and split are
   * written with it and never change, so for the same stock they are not read again. Answers
   * the stock built, or null.
   */
  async function replaceIfStale(
    repos: Repos,
    enrolled: Enrollment,
    stock: SessionSummary,
    checked: MaybeStale | null = null,
  ): Promise<Replaced | null> {
    const stale = checked?.stockId === stock.id ? checked : await mayBeStale(repos, enrolled, stock);
    if (!stale) return null;
    const read = await readChoice(repos, enrolled, stale.devices);
    if (!read || !splitChanged(stale.recorded, targetSplit(read.input))) return null;
    const chosen = await choosePicks(repos, enrolled, read);
    if (!chosen || !(await repos.session.retireStock(stock.id))) return null;
    return { retired: stock.id, ...(await writeStock(repos, enrolled, stale.devices, read, chosen)) };
  }

  /** Phase 43 (spec D3). A stock made, once its transaction committed. Phase 53 (spec D8):
   *  each target its choice found ended on its date, first. */
  function logStocked(enrollmentId: string, stocked: Stocked, reason: StockSessionPayload['reason'] | 'create' | 'stale_split'): void {
    for (const targetId of stocked.endedOnDate) logger.info({ event: 'target_ended', target_id: targetId, how: 'on_date' });
    logger.info({ event: 'session_stocked', enrollment_id: enrollmentId, session_id: stocked.sessionId, reason });
  }

  /** Phase 53 (ruling R-D12). A stale stock retired, and the stock built in its place. */
  function logReplaced(enrollmentId: string, replaced: Replaced): void {
    logger.info({ event: 'session_retired', enrollment_id: enrollmentId, session_id: replaced.retired, reason: 'stale_split' });
    logStocked(enrollmentId, replaced, 'stale_split');
  }

  const service = {
    /**
     * The next session to play (phase 43, spec D5). A started session is
     * resumed, not replaced: SessionOpen. The stock is the next one, answered
     * as it is, built for whichever device asked first. Otherwise the first
     * session is the seed, ready at once, and every later one is built here
     * from the saved list, preparing. The indexes (repo -> SessionOpen) are what
     * hold under a race. Phase 53 (ruling R-D12): a stock chosen on an earlier
     * day whose split is stale is replaced first, and the new one answered.
     */
    createNextSession: async (actorUserId: string, enrollmentId: string, options: Devices): Promise<NextSession> => {
      const { stocked, replaced, ...next } = await transaction(async (repos): Promise<NextSession & { stocked?: Stocked; replaced?: Replaced }> => {
        const { session, question } = repos;
        // No implicit creation: an unknown enrollment is a 404, another
        // learner's a 403, both before anything is written.
        const enrolled = await authorizeEnrollment(repos, logger, {
          actorUserId,
          enrollmentId,
          permission: 'session.practice',
        });

        // Review C1. A double tap, or the stock job, waits here for the other.
        await session.lockNextSession(enrollmentId);
        const open = await session.findOpen(enrollmentId);
        if (open.started) throw new SessionOpen(enrollmentId);
        if (open.stock) {
          // Phase 53 (ruling R-D12). Answered as it is, unless its split is stale.
          const replaced = await replaceIfStale(repos, enrolled, open.stock);
          if (replaced) return { sessionId: replaced.sessionId, status: 'preparing', source: 'list', created: true, replaced };
          return { sessionId: open.stock.id, status: open.stock.status, source: open.stock.source, created: false };
        }

        const latest = await session.findLatest(enrollmentId);
        if (nextSource(latest !== undefined) === 'seed') {
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

        const stocked = await stockNext(repos, enrolled, options);
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
     * another started session of the enrollment is SessionOpen.
     */
    startSession: async (actorUserId: string, sessionId: string, devices: Devices): Promise<{ sessionId: string; status: SessionStatus }> => {
      const started = await transaction(async (repos) => {
        const enrolled = await authorizeSession(repos, logger, actorUserId, sessionId);
        const state = await repos.session.findState(sessionId);
        if (!state) throw new SessionNotFound(sessionId);
        if (state.status !== 'ready') throw new SessionNotReady(sessionId, state.status);
        const changed = await repos.session.markStarted(sessionId);
        if (changed) await requestStock(repos, { enrollment_id: enrolled.id, reason: 'start', ...devices });
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

    /** What the home screen needs in one read. Phase 43 (spec D6): the started
     *  session, else the stock, else the newest session if it failed, so a
     *  failure is never silent. Spec D8: an unstarted list session offered is
     *  logged with its status, which counts how often a learner found it ready.
     *  Phase 53 (ruling R-D12): home learns of the stock here, so a stock chosen
     *  on an earlier day is checked here, and offered replaced when its split is
     *  stale. Create's lock is taken only when the cheap half holds (a stock
     *  chosen on an earlier day, with a split recorded or a target active), and
     *  the stock is read again under it. */
    currentSession: async (
      actorUserId: string,
      enrollmentId: string,
    ): Promise<{ current: SessionSummary | null; nextSource: SessionSource; savedCount: number }> => {
      const read = await transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'session.practice' });
        let open = await repos.session.findOpen(enrollmentId);
        let replaced: Replaced | null = null;
        // Phase 53 (ruling R-D12). The lock only for a stock chosen on an earlier day that a
        // target can have made stale; what that read is not read again for the same stock.
        const checked = !open.started && open.stock ? await mayBeStale(repos, enrolled, open.stock) : null;
        if (checked) {
          await repos.session.lockNextSession(enrollmentId);
          open = await repos.session.findOpen(enrollmentId);
          replaced = !open.started && open.stock ? await replaceIfStale(repos, enrolled, open.stock, checked) : null;
          if (replaced) open = { stock: { id: replaced.sessionId, status: 'preparing', source: 'list', answered: 0, total: 0 } };
        }
        const latest = await repos.session.findLatest(enrollmentId);
        return {
          current: open.started ?? open.stock ?? (latest?.status === 'failed' ? latest : null),
          offered: open.started ? undefined : open.stock,
          nextSource: nextSource(latest !== undefined),
          savedCount: await repos.vocabulary.countEntries(enrollmentId),
          replaced,
        };
      });
      const { offered, replaced, ...home } = read;
      if (replaced) logReplaced(enrollmentId, replaced);
      if (offered && offered.source === 'list') {
        logger.info({ event: 'session_offered', enrollment_id: enrollmentId, session_id: offered.id, status: offered.status });
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
        const changed = await repos.session.transition(sessionId, ['preparing', 'ready'], 'skipped', day);
        // Phase 20. The answers given before the skip are real answers.
        if (changed) {
          await repos.session.resolvePendingRetry(sessionId, { text: '', verdict: 'gave_up' });
          await recordProgress(repos, sessionId);
          // Phase 43 (spec D3). The next session in stock, if this was it. Not
          // after the seed (ruling R8): it is played before anything is saved,
          // and a stock built behind the first saves would hold one word.
          if (state.source === 'list') await requestStock(repos, { enrollment_id: enrolled.id, reason: 'skip' });
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
      { retry = false, hintOpened, fits = false }: { retry?: boolean; hintOpened?: boolean; fits?: boolean } = {},
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

        // Phase 43 (spec D2). A first answer starts a session no start call
        // started (an older app, a bot), and asks for the next one in stock.
        // Another started session refuses it here, before anything commits.
        if (outcome.recorded === 'answer' && loaded.answers.length === 0 && (await repos.session.markStarted(sessionId))) {
          await requestStock(repos, { enrollment_id: enrolled.id, reason: 'answer' });
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
          await recordProgress(repos, sessionId);
          // Phase 43 (spec D3). A stock that failed, or was never built, is
          // built now; one already there makes this a no-op.
          await requestStock(repos, { enrollment_id: enrolled.id, reason: 'complete' });
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
      input: { questionId: string; text: string; retry?: boolean; helped?: boolean },
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
      const session = await service.submitAnswer(actorUserId, sessionId, input.questionId, answer, { retry });
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
        const practised = await memory.findPractisedWords({ enrollmentId: state.enrollmentId, limit: MAX_LEARNER_WORDS });
        const learnerWords: LearnerWord[] = practised.map((word, index) => ({ key: `w${index + 1}`, ...word }));
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
        { listening: payload.listening, speaking: payload.speaking },
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
     * Phase 43 (spec D3). The stock job: builds the enrollment's next session in
     * stock when it has none, has had a session (else the seed comes next) and
     * has words to ask. Anything else is a no-op, logged with why; so is a race
     * lost to another stock. Built for the start's device when the trigger was a
     * start, else the newest session's (ruling R2).
     */
    stockSession: async (data: unknown): Promise<void> => {
      const payload = StockSessionPayloadSchema.parse(data);
      const enrollmentId = payload.enrollment_id;
      type Outcome = Stocked | { why: 'no_enrollment' | 'stocked' | 'seed_next' | 'no_saved_words' };
      let outcome: Outcome;
      try {
        outcome = await transaction(async (repos): Promise<Outcome> => {
          const enrolled = await repos.enrollment.findById(enrollmentId);
          if (!enrolled) return { why: 'no_enrollment' };
          // Review C1. A create running now finishes first, and its stock is seen.
          await repos.session.lockNextSession(enrollmentId);
          if ((await repos.session.findOpen(enrollmentId)).stock) return { why: 'stocked' };
          if (!(await repos.session.findLatest(enrollmentId))) return { why: 'seed_next' };
          const devices =
            payload.listening !== undefined && payload.speaking !== undefined
              ? { listening: payload.listening, speaking: payload.speaking }
              : ((await repos.session.findNewestDevices(enrollmentId)) ?? { listening: false, speaking: false });
          return stockNext(repos, enrolled, devices);
        });
      } catch (error) {
        if (error instanceof SessionOpen) outcome = { why: 'stocked' };
        else if (error instanceof NoSavedWords) outcome = { why: 'no_saved_words' };
        else throw error;
      }
      if ('sessionId' in outcome) logStocked(enrollmentId, outcome, payload.reason);
      else logger.info({ event: 'session_stock_skipped', enrollment_id: enrollmentId, reason: payload.reason, why: outcome.why });
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

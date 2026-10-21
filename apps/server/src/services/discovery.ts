import type {
  DiscoveryAnswerRequest,
  DiscoveryAnswerResult,
  DiscoveryProfile,
  DiscoveryProfileCreate,
  DiscoveryRun,
  DiscoveryState,
  Enrollment,
  PhotoImportItem,
  TranslationRequest,
  TranslationResponse,
  TypedVerdict,
} from '@lang-tutor/core/api';
import { wrongScript } from '@lang-tutor/core/domain';

import { MAX_ROUNDS, buildDiscoveryPrompt, firstLevel, levelAfter, parseDiscovery, wordKey } from '../domain/discovery';
import { LOOK_UP_DISCOVERED_WORD } from '../domain/jobs';
import { buildMeaningJudgePrompt, meaningRuleVerdict, parseMeaningJudge } from '../domain/judge';
import { LANGUAGES, type LanguageCode } from '../domain/languages';
import { DiscoveryConflict, DiscoveryNotFound, LlmUnavailable, WrongScript } from '../errors';
import type { Logger } from '../logger';
import type { CardRow, CardVerdict, JudgedBy, ProfileRow, RunRow } from '../repo/discovery';
import { authorizeEnrollment } from './access';
import type { LlmClient } from './llm';
import type { Repos, Transaction } from './transaction';

function toProfile(row: ProfileRow): DiscoveryProfile {
  return { self_level: row.selfLevel, learning_context: row.learningContext, level: row.level };
}

/** A card the learner did not know, as a photo row: the list is reviewed the same way. */
function toItem(card: CardRow): PhotoImportItem {
  return {
    position: card.position,
    text: card.word,
    hebrew: card.hebrew,
    status: card.lookupStatus ?? 'pending',
    corrected_form: card.correctedForm,
    options: card.options,
    chosen_gloss_id: card.chosenGlossId,
    ticked: card.ticked,
    hebrew_mismatch: card.hebrewMismatch,
    reason: card.reason,
  };
}

const lastRoundOf = (cards: readonly CardRow[]) => cards.reduce((max, card) => Math.max(max, card.round), 0);
const unknownOf = (cards: readonly CardRow[]) => cards.filter((card) => card.known === false);

/** Spec D10. A run on the wire: its unanswered cards while it asks, and its list. */
export function toRun(run: RunRow, cards: readonly CardRow[]): DiscoveryRun {
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    unknown_count: unknownOf(cards).length,
    round: lastRoundOf(cards),
    cards: run.status === 'asking' ? cards.filter((card) => card.answer === null).map((card) => ({ position: card.position, word: card.word })) : [],
    items: unknownOf(cards).map(toItem),
  };
}

/**
 * Spec D3. Closes the run's last round, once: the profile's level moved by its answered
 * cards, and the round recorded as settled. Inside the caller's transaction, which holds
 * the run's row. Answers the level before and after, or null when the round was settled.
 */
async function settle(repos: Repos, run: RunRow, cards: readonly CardRow[]): Promise<{ before: number; after: number } | null> {
  const round = lastRoundOf(cards);
  if (round === 0 || round <= run.settledRound) return null;
  const profile = await repos.discovery.findProfile(run.enrollmentId);
  if (!profile) throw new DiscoveryConflict(run.id, 'no profile');
  const answered = cards.filter((card) => card.round === round && card.known !== null);
  const after = levelAfter(profile.level, answered.map((card) => ({ known: card.known === true })));
  if (after !== profile.level) await repos.discovery.setLevel(run.enrollmentId, after);
  await repos.discovery.setSettledRound(run.id, round);
  return { before: profile.level, after };
}

/** Spec D4. The words to leave out, newest first, each once: every word the learner
 *  answered in any run, this one's included, then the saved lemmas. */
function excludeOf(answered: readonly string[], saved: readonly string[]): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of [...answered, ...saved]) {
    const key = wordKey(word);
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

/**
 * Phase 69. Words for me: a learner's profile, a run's rounds and answers, its list, its
 * save, and the job that looks a word up (spec D2–D10).
 *
 * Every learner use case is the list owner's alone (`discovery.manage`, in no role),
 * checked inside its transaction. The model is called between transactions, never inside
 * one (ADR 0001 R8): a round reads, calls, then writes under the run's row lock and
 * rechecks that nothing changed meanwhile.
 */
export function createDiscoveryService({
  transaction,
  discover,
  judge,
  llm,
  lookup,
  now,
  logger,
  stockSaveDelaySeconds,
}: {
  transaction: Transaction;
  /** Spec D4. The round's own client. */
  discover: LlmClient;
  /** Spec D5. The session's meaning judge client. */
  judge: LlmClient;
  /** The lookup's client, for a row's sense match, as a photo row's. */
  llm: LlmClient;
  lookup: (actorUserId: string, input: TranslationRequest) => Promise<TranslationResponse>;
  now: () => number;
  logger: Logger;
  stockSaveDelaySeconds: number;
}) {
  /** A run is addressed by its own id; its enrollment decides. Locked when asked. */
  const authorizeRun = async (repos: Repos, actorUserId: string, runId: string, lock: boolean): Promise<{ run: RunRow; enrolled: Enrollment }> => {
    const run = lock ? await repos.discovery.findRunForUpdate(runId) : await repos.discovery.findRun(runId);
    if (!run) throw new DiscoveryNotFound(runId);
    const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId: run.enrollmentId, permission: 'discovery.manage' });
    return { run, enrolled };
  };

  /** Moves an asking run to its list, settling its round first. The caller holds the row. */
  const toList = async (repos: Repos, run: RunRow, cards: readonly CardRow[], reason: string): Promise<RunRow> => {
    const settled = await settle(repos, run, cards);
    await repos.discovery.transition(run.id, ['asking'], 'listing');
    logger.info({
      event: 'discovery_listing',
      run_id: run.id,
      reason,
      unknown_count: unknownOf(cards).length,
      ...(settled ? { level_before: settled.before, level_after: settled.after } : {}),
    });
    return { ...run, status: 'listing' };
  };

  return {
    state: async (actorUserId: string, enrollmentId: string): Promise<DiscoveryState> =>
      transaction(async (repos) => {
        await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'discovery.manage' });
        const profile = await repos.discovery.findProfile(enrollmentId);
        const run = await repos.discovery.findOpenRun(enrollmentId);
        return {
          profile: profile ? toProfile(profile) : null,
          run: run ? toRun(run, await repos.discovery.listCards(run.id)) : null,
        };
      }),

    /** Spec D2. The two answers, once. */
    createProfile: async (actorUserId: string, enrollmentId: string, input: DiscoveryProfileCreate): Promise<DiscoveryProfile> => {
      const profile = await transaction(async (repos) => {
        await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'discovery.manage' });
        const inserted = await repos.discovery.insertProfile({
          enrollmentId,
          selfLevel: input.self_level,
          learningContext: input.learning_context,
          level: firstLevel(input.self_level),
        });
        if (!inserted) throw new DiscoveryConflict(enrollmentId, 'profile exists');
        return inserted;
      });
      logger.info({
        event: 'discovery_profile_created',
        enrollment_id: enrollmentId,
        self_level: profile.selfLevel,
        learning_context: profile.learningContext,
        level: profile.level,
      });
      return toProfile(profile);
    },

    /** Spec D6, D8. A new run, or the open one: starting again resumes it. */
    start: async (actorUserId: string, enrollmentId: string, goal: number): Promise<{ run: DiscoveryRun; created: boolean }> => {
      const started = await transaction(async (repos) => {
        await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'discovery.manage' });
        if (!(await repos.discovery.findProfile(enrollmentId))) throw new DiscoveryConflict(enrollmentId, 'no profile');
        const inserted = await repos.discovery.insertRun({ enrollmentId, goal });
        if (inserted) return { run: toRun(inserted, []), created: true };
        // The open-run index refused it: answer the open one.
        const open = await repos.discovery.findOpenRun(enrollmentId);
        if (!open) throw new DiscoveryConflict(enrollmentId, 'no open run');
        return { run: toRun(open, await repos.discovery.listCards(open.id)), created: false };
      });
      logger.info({ event: started.created ? 'discovery_started' : 'discovery_resumed', enrollment_id: enrollmentId, run_id: started.run.id, goal: started.run.goal });
      return started;
    },

    getRun: async (actorUserId: string, runId: string): Promise<DiscoveryRun> =>
      transaction(async (repos) => {
        const { run } = await authorizeRun(repos, actorUserId, runId, false);
        return toRun(run, await repos.discovery.listCards(runId));
      }),

    /**
     * Spec D3, D4, D8. The next round, when the run asks and every card is answered;
     * otherwise the run as it is. Reads, calls the model outside any transaction, then
     * writes under the run's lock, unless a card was written meanwhile. At MAX_ROUNDS, or
     * when the model has no word left, the run goes to its list instead.
     */
    nextRound: async (actorUserId: string, runId: string): Promise<DiscoveryRun> => {
      const read = await transaction(async (repos) => {
        const { run, enrolled } = await authorizeRun(repos, actorUserId, runId, false);
        const cards = await repos.discovery.listCards(runId);
        if (run.status !== 'asking' || cards.some((card) => card.answer === null)) return { kind: 'asIs' as const, run: toRun(run, cards) };
        const profile = await repos.discovery.findProfile(run.enrollmentId);
        if (!profile) throw new DiscoveryConflict(runId, 'no profile');
        const round = lastRoundOf(cards);
        if (round >= MAX_ROUNDS) return { kind: 'atCap' as const, cardCount: cards.length };
        const user = await repos.user.findById(enrolled.user_id);
        const exclude = excludeOf(await repos.discovery.answeredWords(run.enrollmentId), await repos.vocabulary.savedLemmas(run.enrollmentId));
        // The level this round is asked at: the profile's, moved by the round it closes.
        const level =
          round > run.settledRound
            ? levelAfter(
                profile.level,
                cards.filter((card) => card.round === round && card.known !== null).map((card) => ({ known: card.known === true })),
              )
            : profile.level;
        return { kind: 'ask' as const, enrolled, profile, cardCount: cards.length, round, level, age: user?.age ?? 18, exclude };
      });
      if (read.kind === 'asIs') return read.run;

      let words: { word: string; partOfSpeech: CardRow['partOfSpeech']; hebrew: string; alternatives: string[] }[] = [];
      let dropped = 0;
      let ms = 0;
      if (read.kind === 'ask') {
        const started = now();
        const raw = await discover({
          ...buildDiscoveryPrompt({
            target: read.enrolled.target_language as LanguageCode,
            level: read.level,
            age: read.age,
            learningContext: read.profile.learningContext,
            exclude: read.exclude,
          }),
          record: { kind: 'discovery', enrollmentId: read.enrolled.id, userId: read.enrolled.user_id },
        });
        ms = now() - started;
        // An empty string is the provider's "no content": no word, not a failure.
        const parsed = raw === '' ? { words: [], dropped: 0 } : parseDiscovery(raw, new Set(read.exclude.map(wordKey)));
        if (!parsed) {
          logger.info({ event: 'discovery_round_unreadable', run_id: runId, ms });
          throw new LlmUnavailable('the proposed words were unreadable');
        }
        words = parsed.words;
        dropped = parsed.dropped;
      }

      return transaction(async (repos) => {
        const { run } = await authorizeRun(repos, actorUserId, runId, true);
        const cards = await repos.discovery.listCards(runId);
        if (run.status !== 'asking' || cards.length !== read.cardCount || cards.some((card) => card.answer === null)) {
          logger.info({ event: 'discovery_round_dropped', run_id: runId });
          return toRun(run, cards);
        }
        if (words.length === 0) {
          const listed = await toList(repos, run, cards, read.kind === 'atCap' ? 'rounds' : 'no_words');
          return toRun(listed, cards);
        }
        const settled = await settle(repos, run, cards);
        const level = settled?.after ?? (await repos.discovery.findProfile(run.enrollmentId))!.level;
        const round = lastRoundOf(cards) + 1;
        const start = cards.reduce((max, card) => Math.max(max, card.position + 1), 0);
        await repos.discovery.insertCards(
          runId,
          words.map((word, index) => ({ position: start + index, round, level, ...word })),
        );
        logger.info({
          event: 'discovery_round',
          run_id: runId,
          round,
          level,
          ...(settled ? { level_before: settled.before } : {}),
          asked: words.length,
          dropped,
          ms,
        });
        return toRun(run, await repos.discovery.listCards(runId));
      });
    },

    /**
     * Spec D5. One card's answer. "Don't know" is unknown. A typed meaning is checked: the
     * alphabet, then the rule, then the meaning judge; a judge that fails counts unknown.
     * An unknown card starts its lookup. The answer that reaches the goal moves the run
     * to its list. A card answered before answers its first verdict.
     */
    answer: async (actorUserId: string, runId: string, position: number, request: DiscoveryAnswerRequest): Promise<DiscoveryAnswerResult> => {
      const checked = await transaction(async (repos) => {
        const { run, enrolled } = await authorizeRun(repos, actorUserId, runId, false);
        const cards = await repos.discovery.listCards(runId);
        const card = cards.find((candidate) => candidate.position === position);
        if (!card) throw new DiscoveryNotFound(runId, position);
        if (card.answer !== null) return { kind: 'replay' as const, answer: { known: card.known === true, meaning: card.hebrew, run: toRun(run, cards) } };
        if (run.status !== 'asking') throw new DiscoveryConflict(runId, 'not asking');
        return { kind: 'fresh' as const, card, enrolled };
      });
      if (checked.kind === 'replay') return checked.answer;
      const { card, enrolled } = checked;

      let verdict: CardVerdict | null = null;
      let judgedBy: JudgedBy | null = null;
      if (request.kind === 'typed') {
        const source = enrolled.source_language as LanguageCode;
        if (wrongScript(request.text, source)) {
          logger.info({ event: 'discovery_wrong_script', run_id: runId, position });
          throw new WrongScript(`${runId}/${position}`, LANGUAGES[source].name);
        }
        const rule = meaningRuleVerdict(card.hebrew, request.text, card.alternatives);
        if (rule !== null) {
          verdict = asCardVerdict(rule);
          judgedBy = 'rule';
        } else {
          try {
            const raw = await judge({
              ...buildMeaningJudgePrompt(
                {
                  language: enrolled.target_language as LanguageCode,
                  explanation: source,
                  form: card.word,
                  lemma: card.word,
                  partOfSpeech: card.partOfSpeech,
                  meaning: card.hebrew,
                  example: null,
                  exampleTranslation: null,
                  alternatives: card.alternatives,
                },
                request.text,
              ),
              record: { kind: 'judge', enrollmentId: enrolled.id, userId: enrolled.user_id },
            });
            const judged = parseMeaningJudge(raw);
            if (judged === null) throw new LlmUnavailable('the verdict was unreadable');
            verdict = asCardVerdict(judged);
            judgedBy = 'model';
          } catch (error) {
            logger.info({
              event: 'discovery_judge_failed',
              run_id: runId,
              position,
              reason: error instanceof Error ? error.name : 'unknown',
            });
            judgedBy = 'unavailable';
          }
        }
      }
      const known = verdict === 'exact' || verdict === 'alternative';

      const outcome = await transaction(async (repos): Promise<{ answer: DiscoveryAnswerResult; wrote: boolean }> => {
        const { run } = await authorizeRun(repos, actorUserId, runId, true);
        const asAnswered = (cards: readonly CardRow[], at: RunRow) => {
          const answered = cards.find((candidate) => candidate.position === position)!;
          return { answer: { known: answered.known === true, meaning: answered.hebrew, run: toRun(at, cards) }, wrote: false };
        };
        if (run.status !== 'asking') {
          const cards = await repos.discovery.listCards(runId);
          if (cards.find((candidate) => candidate.position === position)?.answer) return asAnswered(cards, run);
          throw new DiscoveryConflict(runId, 'not asking');
        }
        const wrote = await repos.discovery.answerCard(runId, position, {
          answer: request.kind,
          typedText: request.kind === 'typed' ? request.text : null,
          verdict,
          known,
          judgedBy,
          lookupStatus: known ? null : 'pending',
          answeredAt: new Date(now()),
        });
        const cards = await repos.discovery.listCards(runId);
        // Another answer of this card landed first: it stands.
        if (!wrote) return asAnswered(cards, run);
        if (!known) await repos.jobs.enqueue(LOOK_UP_DISCOVERED_WORD, { run_id: runId, position });
        const reached = unknownOf(cards).length >= run.goal;
        const current = reached ? await toList(repos, run, cards, 'goal') : run;
        return { answer: { known, meaning: card.hebrew, run: toRun(current, cards) }, wrote: true };
      });
      if (outcome.wrote) {
        logger.info({ event: 'discovery_answered', run_id: runId, position, answer: request.kind, judged_by: judgedBy, known });
      }
      return outcome.answer;
    },

    /** Spec D8. "לרשימה": the run goes to its list now. A listing run answers as it is. */
    end: async (actorUserId: string, runId: string): Promise<DiscoveryRun> =>
      transaction(async (repos) => {
        const { run } = await authorizeRun(repos, actorUserId, runId, true);
        const cards = await repos.discovery.listCards(runId);
        if (run.status === 'listing') return toRun(run, cards);
        if (run.status !== 'asking') throw new DiscoveryConflict(runId, `already ${run.status}`);
        return toRun(await toList(repos, run, cards, 'end'), cards);
      }),
  };
}

/** The judge's three verdicts are the card's. */
function asCardVerdict(verdict: TypedVerdict): CardVerdict {
  return verdict === 'exact' || verdict === 'alternative' ? verdict : 'wrong';
}

export type DiscoveryService = ReturnType<typeof createDiscoveryService>;

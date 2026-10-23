import type {
  DiscoveryAnswerRequest,
  DiscoveryProfile,
  DiscoveryProfileCreate,
  DiscoveryRun,
  DiscoveryState,
  Enrollment,
  TranslationRequest,
  TranslationResponse,
} from '@lang-tutor/core/api';

import { DISCOVER_COUNT, MAX_ROUNDS, buildDiscoveryPrompt, choicesOf, firstLevel, levelAfter, parseDiscovery, wordKey } from '../domain/discovery';
import { LOOK_UP_DISCOVERED_WORD, LookUpDiscoveredWordPayloadSchema } from '../domain/jobs';
import { type LanguageCode } from '../domain/languages';
import { entriesToSave, type ImportItemState } from '../domain/photoImports';
import { firstPerGloss } from '../domain/vocabulary';
import { DiscoveryConflict, DiscoveryNotFound, InvalidDiscoveryAnswer, LlmUnavailable, SenseMatchUnreadable } from '../errors';
import type { Logger } from '../logger';
import type { CardRow, ProfileRow, RunRow, Suggestion } from '../repo/discovery';
import { authorizeEnrollment } from './access';
import type { LlmClient } from './llm';
import { lookUpRow } from './rowLookup';
import { requestStock } from './stock';
import { saveEntriesInTx } from './vocabulary';
import type { Repos, Transaction } from './transaction';

function toProfile(row: ProfileRow): DiscoveryProfile {
  return { self_level: row.selfLevel, learning_context: row.learningContext, level: row.level };
}

/** An added card as the photo import's save rule reads it. */
function asRowState(card: CardRow): ImportItemState {
  return {
    position: card.position,
    status: card.lookupStatus ?? 'pending',
    options: card.options,
    suggestedGlossId: card.suggestedGlossId,
    chosenGlossId: card.chosenGlossId,
    ticked: card.ticked,
  };
}

const lastRoundOf = (cards: readonly CardRow[]) => cards.reduce((max, card) => Math.max(max, card.round), 0);
const addedOf = (cards: readonly CardRow[]) => cards.filter((card) => card.added === true);
const savedCountOf = (cards: readonly CardRow[]) => cards.filter((card) => card.savedAt !== null).length;

/** Phase 74 (spec D9, D11). An added word as far as its lookup got: saved, still looked up, or
 *  failed (its lookup gave no gloss, or ran out of retries). */
function addedStatus(card: CardRow): 'pending' | 'saved' | 'failed' {
  if (card.savedAt !== null) return 'saved';
  return card.lookupStatus === 'pending' ? 'pending' : 'failed';
}

/** Phase 74 (spec D9, builder check B2). A saved word shows the meaning saved; until then the
 *  card's own. */
function addedMeaning(card: CardRow): string {
  const saved = card.savedAt === null ? undefined : card.options.find((option) => option.gloss_id === card.chosenGlossId);
  return saved?.translation ?? card.hebrew;
}

/** Phase 74 (spec D11). A run on the wire: its unanswered cards while it asks, and what was added. */
export function toRun(run: RunRow, cards: readonly CardRow[]): DiscoveryRun {
  const added = addedOf(cards);
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    started_by: run.startedBy,
    added_count: added.length,
    round: lastRoundOf(cards),
    cards:
      run.status === 'asking'
        ? cards
            .filter((card) => card.answer === null)
            .map((card) => ({ position: card.position, word: card.word, choices: card.choices, right: card.rightChoice ?? 0 }))
        : [],
    added: added.map((card) => ({
      position: card.position,
      word: card.correctedForm ?? card.word,
      meaning: addedMeaning(card),
      status: addedStatus(card),
    })),
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
 * Phase 69. Words for me: a learner's profile, a run's rounds and answers, and the job that
 * looks a word up (spec D2–D10). Phase 74: a card's answer is a pick and whether to add the
 * word; an added word is looked up and saved to My words as the lookup lands, and the run's
 * 2nd saved word, or a save after it ended, asks for the session at once (spec D2–D6).
 *
 * Every learner use case is the list owner's alone (`discovery.manage`, in no role),
 * checked inside its transaction. The model is called between transactions, never inside
 * one (ADR 0001 R8): a round reads, calls, then writes under the run's row lock and
 * rechecks that nothing changed meanwhile.
 */
export function createDiscoveryService({
  transaction,
  discover,
  llm,
  lookup,
  now,
  rng,
  logger,
}: {
  transaction: Transaction;
  /** Spec D4. The round's own client. */
  discover: LlmClient;
  /** The lookup's client, for a word's sense match, as a photo row's. */
  llm: LlmClient;
  lookup: (actorUserId: string, input: TranslationRequest) => Promise<TranslationResponse>;
  now: () => number;
  /** Phase 74 (spec D4). Shuffles each card's four meanings. */
  rng: () => number;
  logger: Logger;
}) {
  /** A run is addressed by its own id; its enrollment decides. Locked when asked. */
  const authorizeRun = async (repos: Repos, actorUserId: string, runId: string, lock: boolean): Promise<{ run: RunRow; enrolled: Enrollment }> => {
    const run = lock ? await repos.discovery.findRunForUpdate(runId) : await repos.discovery.findRun(runId);
    if (!run) throw new DiscoveryNotFound(runId);
    const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId: run.enrollmentId, permission: 'discovery.manage' });
    return { run, enrolled };
  };

  /**
   * Phase 74 (spec D5, D6). Ends an asking run, settling its round first; with a word of it
   * already saved, asks for the session at once (a run that ends at one word still gets one).
   * The caller holds the row.
   */
  const endRun = async (repos: Repos, run: RunRow, cards: readonly CardRow[], reason: string): Promise<RunRow> => {
    const settled = await settle(repos, run, cards);
    await repos.discovery.transition(run.id, ['asking'], 'saved');
    const savedCount = savedCountOf(cards);
    if (savedCount > 0) await requestStock(repos, { enrollment_id: run.enrollmentId, reason: 'discovery' });
    logger.info({
      event: 'discovery_ended',
      run_id: run.id,
      reason,
      added_count: addedOf(cards).length,
      saved_count: savedCount,
      ...(settled ? { level_before: settled.before, level_after: settled.after } : {}),
    });
    return { ...run, status: 'saved' };
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

    /**
     * Phase 74 (spec D6, D8). A new run, or the open one: starting again resumes it. A goal is
     * the learner's choice; null is a run the app started, whose goal is the learner's setting.
     */
    start: async (actorUserId: string, enrollmentId: string, goal: number | null): Promise<{ run: DiscoveryRun; created: boolean }> => {
      const started = await transaction(async (repos) => {
        const enrolled = await authorizeEnrollment(repos, logger, { actorUserId, enrollmentId, permission: 'discovery.manage' });
        if (!(await repos.discovery.findProfile(enrollmentId))) throw new DiscoveryConflict(enrollmentId, 'no profile');
        const chosen = goal ?? (await repos.user.findNewWordLimits(enrolled.user_id)).discoverCount ?? DISCOVER_COUNT;
        const inserted = await repos.discovery.insertRun({ enrollmentId, goal: chosen, startedBy: goal === null ? 'app' : 'learner' });
        if (inserted) return { run: toRun(inserted, []), created: true };
        // The open-run index refused it: answer the open one.
        const open = await repos.discovery.findOpenRun(enrollmentId);
        if (!open) throw new DiscoveryConflict(enrollmentId, 'no open run');
        return { run: toRun(open, await repos.discovery.listCards(open.id)), created: false };
      });
      logger.info({
        event: started.created ? 'discovery_started' : 'discovery_resumed',
        enrollment_id: enrollmentId,
        run_id: started.run.id,
        goal: started.run.goal,
        started_by: started.run.started_by,
      });
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
     * when the model has no word left, the run ends instead. Phase 74: each card's four
     * meanings are shuffled as it is written.
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

      let words: { word: string; partOfSpeech: CardRow['partOfSpeech']; hebrew: string; alternatives: string[]; wrong: string[] }[] = [];
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
        // An empty string is the provider's "no content", a refusal of the app's own prompt:
        // unavailable, so the learner can try again, never a run ended with nothing in it.
        const parsed = raw === '' ? null : parseDiscovery(raw, new Set(read.exclude.map(wordKey)));
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
          const ended = await endRun(repos, run, cards, read.kind === 'atCap' ? 'rounds' : 'no_words');
          return toRun(ended, cards);
        }
        const settled = await settle(repos, run, cards);
        const level = settled?.after ?? (await repos.discovery.findProfile(run.enrollmentId))!.level;
        const round = lastRoundOf(cards) + 1;
        const start = cards.reduce((max, card) => Math.max(max, card.position + 1), 0);
        await repos.discovery.insertCards(
          runId,
          words.map((word, index) => {
            const { choices, right } = choicesOf(word.hebrew, word.wrong, rng);
            return {
              position: start + index,
              round,
              level,
              word: word.word,
              partOfSpeech: word.partOfSpeech,
              hebrew: word.hebrew,
              alternatives: word.alternatives,
              choices,
              rightChoice: right,
            };
          }),
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
     * Phase 74 (spec D2, D3, D5, D6). One card's answer: the meaning picked (null is "אין לי
     * מושג") and whether the word joins My words. The suggestion the learner saw is "don't add"
     * after a right pick, "add" otherwise; a card is known for the level when its pick was right
     * and it was not added. An added card starts its lookup, which saves it. The answer that
     * adds the goal's last word ends the run. A card answered before answers the run: its first
     * answer stands.
     */
    answer: async (actorUserId: string, runId: string, position: number, request: DiscoveryAnswerRequest): Promise<DiscoveryRun> =>
      transaction(async (repos) => {
        const { run } = await authorizeRun(repos, actorUserId, runId, true);
        const cards = await repos.discovery.listCards(runId);
        const card = cards.find((candidate) => candidate.position === position);
        if (!card) throw new DiscoveryNotFound(runId, position);
        if (card.answer !== null) return toRun(run, cards);
        if (run.status !== 'asking') throw new DiscoveryConflict(runId, 'not asking');
        if (request.pick !== null && request.pick >= card.choices.length) throw new InvalidDiscoveryAnswer(runId, position, request.pick);

        const pickRight = request.pick !== null && request.pick === card.rightChoice;
        const suggested: Suggestion = pickRight ? 'skip' : 'add';
        const known = pickRight && !request.add;
        await repos.discovery.answerCard(runId, position, {
          answer: request.pick === null ? 'unknown' : 'choice',
          picked: request.pick,
          suggested,
          added: request.add,
          known,
          lookupStatus: request.add ? 'pending' : null,
          answeredAt: new Date(now()),
        });
        if (request.add) await repos.jobs.enqueue(LOOK_UP_DISCOVERED_WORD, { run_id: runId, position });
        logger.info({ event: 'discovery_answered', run_id: runId, position, pick_right: pickRight, added: request.add, suggested, known });
        const answered = await repos.discovery.listCards(runId);
        const current = addedOf(answered).length >= run.goal ? await endRun(repos, run, answered, 'goal') : run;
        return toRun(current, answered);
      }),

    /**
     * Phase 74 (spec D8). ✕ with words added: the run ends now. An ended run answers as it is;
     * a discarded one is refused.
     */
    end: async (actorUserId: string, runId: string): Promise<DiscoveryRun> =>
      transaction(async (repos) => {
        const { run } = await authorizeRun(repos, actorUserId, runId, true);
        const cards = await repos.discovery.listCards(runId);
        if (run.status === 'saved') return toRun(run, cards);
        if (run.status !== 'asking') throw new DiscoveryConflict(runId, `already ${run.status}`);
        return toRun(await endRun(repos, run, cards, 'end'), cards);
      }),

    /**
     * Spec D7, phase 74 (D5). The look-up-discovered-word job: an added card looked up as a
     * photo row is (lookUpRow), then one transaction under the run's lock: the lookup written
     * and, when it found a gloss, the word saved to My words (as its owner) and the card
     * stamped. The run's 2nd saved word, or any save after the run ended, asks for the session
     * at once; a discovery save asks for no delayed stock (builder check B3). A run discarded,
     * or a card no longer pending, costs no lookup and takes no write.
     */
    lookUpWord: async (data: unknown): Promise<void> => {
      const { run_id: runId, position } = LookUpDiscoveredWordPayloadSchema.parse(data);
      const read = await transaction(async ({ discovery, enrollment }) => {
        const run = await discovery.findRun(runId);
        if (!run || (run.status !== 'asking' && run.status !== 'saved')) return undefined;
        const card = (await discovery.listCards(runId)).find((candidate) => candidate.position === position);
        if (!card || card.lookupStatus !== 'pending') return undefined;
        const enrolled = await enrollment.findById(run.enrollmentId);
        return enrolled ? { card, enrolled } : undefined;
      });
      if (!read) {
        logger.info({ event: 'discovered_word_dropped', run_id: runId, position, stage: 'read' });
        return;
      }
      const { result, matchedBy } = await lookUpRow(
        { lookup, llm },
        {
          enrolled: read.enrolled,
          text: read.card.word,
          hebrew: read.card.hebrew,
          record: { kind: 'sense_match', enrollmentId: read.enrolled.id, userId: read.enrolled.user_id },
          onUnreadable: () => new SenseMatchUnreadable(runId, position),
        },
      );
      const outcome = await transaction(async (repos) => {
        const run = await repos.discovery.findRunForUpdate(runId);
        if (!run || (run.status !== 'asking' && run.status !== 'saved')) return { written: false as const };
        if (!(await repos.discovery.writeLookup(runId, position, result))) return { written: false as const };
        const card = (await repos.discovery.listCards(runId)).find((candidate) => candidate.position === position);
        const entries = card?.added ? firstPerGloss(entriesToSave([asRowState(card)])) : [];
        if (entries.length === 0) return { written: true as const, saved: false };
        await saveEntriesInTx(repos, logger, { enrolled: read.enrolled, actorUserId: read.enrolled.user_id, entries, stockSaveDelaySeconds: null });
        await repos.discovery.markSaved(runId, position);
        const savedCount = savedCountOf(await repos.discovery.listCards(runId));
        const stocked = savedCount === 2 || run.status === 'saved';
        if (stocked) await requestStock(repos, { enrollment_id: run.enrollmentId, reason: 'discovery' });
        return { written: true as const, saved: true, savedCount, stocked };
      });
      logger.info({
        event: outcome.written ? 'discovered_word_looked_up' : 'discovered_word_dropped',
        run_id: runId,
        position,
        matched_by: matchedBy,
        corrected: result.correctedForm !== null,
        option_count: result.options.length,
        reason: result.reason,
        ...(outcome.written ? {} : { stage: 'write' }),
      });
      if (outcome.written && outcome.saved) {
        logger.info({
          event: 'discovered_word_saved',
          run_id: runId,
          position,
          hebrew_mismatch: result.hebrewMismatch,
          saved_count: outcome.savedCount,
          stocked: outcome.stocked,
        });
      }
    },

    /** The lookup's dead letter: the word is marked failed; the rest unaffected. */
    failWord: async (data: unknown): Promise<void> => {
      const { run_id: runId, position } = LookUpDiscoveredWordPayloadSchema.parse(data);
      const marked = await transaction(({ discovery }) => discovery.markLookupFailed(runId, position));
      logger.info({ event: 'discovered_word_failed', run_id: runId, position, marked });
    },
  };
}

export type DiscoveryService = ReturnType<typeof createDiscoveryService>;

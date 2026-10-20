import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH, countedSkills, dimensionsTested, gradesFor, type Dimension, type QuestionType } from '@lang-tutor/core/domain';

import { choosePools, chooseWords, liveDimensions, type ChoiceInput, type ChosenPick } from './choose';
import {
  DAY_NEW_CAP,
  KNOWN_STABILITY,
  LADDER_SLOTS,
  NEW_FLOOR,
  NEW_PER_SESSION,
  RETURNS_PER_DAY,
  SPEAKING_PER_SESSION,
} from './chooseConstants';
import { LANE0_DAY } from './day.fixture';
import { glossFamilies, type Families, type FamilyGloss } from './glossFamilies';
import { applySession, type MemoryRow } from './memoryUpdate';
import { RUNGS, planCards } from './plan';
import { daysBetween, evaluateSession, type AnsweredQuestion, type ProgressRow } from './progress';
import { readinessSessionWrite, type TargetReadinessEvent, type TargetReadinessRow } from './readinessWrite';
import { pastBudget, playTodayForward } from './targetBudget';
import { servedSkill, targetDay, type TargetDay, type TargetDayInput } from './targetDay';
import {
  chooseTargetPicks,
  owedWords,
  stockServes,
  stockToCheck,
  targetMode,
  type StockChoice,
  type TargetMode,
  type TargetPickInput,
} from './targetPicker';
import { activeOn, readinessOf, recallOnDue, type TargetKind } from './targets';
import { capHalves, targetSessionWrite, type HoldingTarget, type TargetSkillEvent, type TargetSkillRow } from './targetSkills';
import { readinessSummary, skillStarts } from './targetSummary';
import { dayState, type DayAnswer } from './today';

/**
 * Phase 37 (spec D9). Whole days through the real word choice, card choice,
 * grading, memory and level code, checked against Victor's five outcomes:
 *   1. every session brings new words, within the daily limit;
 *   2. a word met early in the day is recalled later that day;
 *   3. a word answered wrong returns later that day;
 *   4. speaking cards come up regularly when the device records;
 *   5. no word answered right today returns as filler.
 * The lists: lane 0's on 2026-10-11, when the learner did nine sessions and met
 * two new words, then the same list over twenty sessions; and a new learner's
 * thirty saved words, none met yet.
 *
 * Phase 39 (spec D12). Before each session the runner works out the gloss families,
 * carrying known_at from session to session, and plans an introduced gloss as a
 * new_meaning. Every run adds two outcomes:
 *   6. no session asks two glosses of one family;
 *   7. no waiting gloss is ever asked.
 * A last run follows a five-meaning word over days of sessions.
 *
 * Phase 53 (spec §2). Targets, word lists with a kind and a due date, run beside lane 0's
 * list: one scenario per row of the spec, each checked session by session against the
 * rules that split a session (D5, D6, the graded wish) and day by day against the pace
 * (D7), with the share of a list ready on its due date as the measure.
 *
 * Phase 54 (spec §2). A new word's first session is a ladder: a meet card, then a multiple
 * choice, a reverse choice and a typed translation, spread through the session. The runner
 * plans each pick's ladder flag, and the learner answers a meet card `seen`, outside its miss
 * rhythm. Every run adds four outcomes:
 *   8. every unlearned word is asked as a ladder, its four cards in that order, in its session;
 *   9. no session holds more than three ladders, or more than ten graded cards;
 *  10. no two cards of one word sit side by side while another card can go between them: a lone
 *      ladder with `others` other cards has at most max(0, 3 − others) of its cards after one of
 *      its own, and two ladders or more none;
 *  11. a word whose ladder was all wrong is laddered again later that day, while its returns last.
 * Two runs join them: the new learner's thirty words over days, all met, three a session at
 * most; and a learner who forgets one word, whose ladders outcome 11 follows.
 *
 * Phase 55 (spec D9). The runner plans every pick with tiles and as speakable, in a session that
 * can speak, so a ladder is its intro stage, meet, read aloud and letter tiles, back to back, then
 * the multiple choice, the reverse choice and the typed translation, spread through the session
 * (D2, D3). A ladder takes four slots and a session holds two (D4), and the slots a target leaves
 * never reach the main path (D5). As ruled, the intro stage is for encoding, not evidence: the runner
 * answers its cards as intro cards, which write no memory, no progress and open no return, and which
 * the learner never misses, though the write-it card still takes its slot. Outcomes 8–11 are
 * restated for it:
 *   8. a ladder's intro cards back to back and marked intro, then its three practice cards, in order;
 *   9. two ladders a session at most, and ten graded cards: all but the meet and a ladder's read aloud;
 *  10. the adjacency bound counted outside each word's intro stage;
 *  11. "all wrong" counts the practice cards: the intro stage writes nothing.
 *
 * Phase 57 (spec §7). Phase 53's split session is gone: each target is a path of its own (D1), and
 * the learner plays, session by session, the first card home shows (D11). The target scenarios at
 * the end run on runPaths; phase 53's marks on the share of a list ready by FSRS on its due date
 * stay their gates, and the plan's target skills (D9) have their own.
 *
 * Phase 65 (spec D11). Readiness is the grade the list's words would get on the date (core's rule,
 * kept per target, word and counted skill), and today is a budget of sessions. Phase 57's
 * readiness was the plan's target skills, and its measures stay, named as the plan's; the learner
 * still plays until no target owes work, past the budget. The runner writes readiness at every
 * session end from the main memory as it stood before that session's own write (ruling R1), and
 * sets each target day's budget before its path's first session. Every target scenario adds two
 * outcomes: readiness never moves overnight, and never drops across a session whose answers about
 * the target were all right; checks its own runner sets the day's budget once (the simulation's
 * fidelity: the product's rule is gated in tests/integration/services/sessions.targets.test.ts);
 * and reports, ungated, readiness on the date beside the share ready by FSRS, and how often the
 * day's sessions fit the budget. One more scenario is the spec's anti-goal: an exam whose same
 * skills are missed cold on its last days.
 */

const DIMENSIONS: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];
const CHOICE: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'new_meaning', 'reverse_choice', 'listen_choice', 'matching', 'cloze_choice']);
const SPEAKING_CARDS: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);
/** The cards the fixed learner never misses, outside its rhythm: a read aloud is always
 *  understood, and a meet card (phase 54, spec D1) asks nothing. */
const UNMISSED: ReadonlySet<QuestionType> = new Set(['read_aloud', 'meet']);
/** The recall types: rung 2 of some dimension (spec D6). */
const RECALL: ReadonlySet<QuestionType> = new Set(Object.values(RUNGS).flatMap(([, recall]) => recall));
/** The device listens and records in every session, so every skill is live. */
const LIVE = liveDimensions(true, true);

/** `at` counts sessions across days; `session` counts them within the day. */
type Asked = {
  session: number;
  at: number;
  glossId: string;
  cls: ChosenPick['cls'];
  rung: 1 | 2;
  type: QuestionType;
  right: boolean;
  knownMeanings: readonly string[] | undefined;
  /** Phase 55 (spec D2, as ruled): a card of a ladder's intro stage, which writes no memory, no
   *  progress and opens no return. */
  intro: boolean;
};
type Session = { input: ChoiceInput; picks: ChosenPick[]; families: Families };
type DayList = {
  today: string;
  saved: Omit<FamilyGloss, 'knownAt'>[];
  /** Phase 46: the fixtures predate reachedOn; the runner dates it as migration 0032 does. */
  memory: Omit<MemoryRow, 'reachedOn'>[];
  progress: ProgressRow[];
};

/** A new learner: thirty words saved this morning, none met, each the only meaning
 *  of its word. */
const FRESH: DayList = {
  today: '2026-10-12',
  saved: Array.from({ length: 30 }, (_, i) => ({
    glossId: `n${String(i).padStart(2, '0')}`,
    key: `fresh-${i}`,
    savedAt: `2026-10-12T08:${String(i).padStart(2, '0')}:00.000000Z`,
    lexemeId: `x${i}`,
    lemma: `x${i}`,
    forms: [`f${i}`],
    order: [0, 0] as const,
    speakable: true,
  })),
  memory: [],
  progress: [],
};

/** The fixed learner: every fifth card answered is wrong (every `missEvery`th, for a
 *  run that says otherwise), and a read aloud is always understood (it writes no
 *  memory either way). Phase 54 (spec D1, D6): a meet card asks nothing, so it is never
 *  missed and takes no turn in that rhythm: the learner taps המשך, a `seen` answer.
 *  `phase`: the rhythm starts that many cards in, so a run can miss any card of the five.
 *  `forgets`: glosses the learner answers wrong on every card that asks something.
 *  Phase 55 (spec D2, as ruled): a ladder's intro cards write nothing, so, as a read aloud, they are
 *  never missed and take no turn in the rhythm. A wrong write-it card would show only in the score,
 *  which the runner does not keep, so a turn there would do nothing but move every later miss: as
 *  measured, the five-phase marks then moved by that alone (row 1's ready-on-due 0.58 to 0.55, the
 *  shared spelling's first reading known at two phases to none). */
type Learner = { missEvery: number; phase?: number; forgets?: ReadonlySet<string> };
/** Phase 37's learner, missing one card in five. */
const PHASE_37_LEARNER: Learner = { missEvery: 5 };
/** Phase 54. Phase 37's learner at each phase of its rhythm: missing the first card of five, the
 *  second, and so on. One deterministic learner misses the same places of every ten-card session,
 *  so a measure taken at one phase alone can sit at the rhythm's best or worst. */
const EVERY_PHASE: readonly Learner[] = Array.from({ length: PHASE_37_LEARNER.missEvery }, (_, phase) => ({ ...PHASE_37_LEARNER, phase }));

function answerOf(glossId: string, type: QuestionType, right: boolean): AnsweredQuestion {
  if (type === 'meet') return { glossId, type, verdict: 'seen' };
  if (CHOICE.has(type)) return { glossId, type, correct: right } as AnsweredQuestion;
  if (type === 'read_aloud') return { glossId, type, verdict: 'understood' };
  if (type === 'say_translation') return { glossId, type, verdict: right ? 'understood' : 'gave_up' };
  return { glossId, type, verdict: right ? 'exact' : 'wrong' } as AnsweredQuestion;
}

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}|${dimension}`;
/** Phase 54 (spec D4). The session slots `picks` take: a ladder LADDER_SLOTS, any other pick one. */
const slotsOf = (picks: readonly ChosenPick[]) => picks.reduce((sum, pick) => sum + (pick.ladder ? LADDER_SLOTS : 1), 0);
const dayAfter = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** `days` days of `count` sessions over `list`, each session ended as recordProgress
 *  ends one. Memory, levels, the words met and known_at carry from day to day; the
 *  day's answers and the words it introduced start again each day.
 *
 *  Phase 53. A gloss is saved from the day of its savedAt (every gloss of the older
 *  lists is saved by their first day). Every session is chooseWords' (phase 57: the main
 *  path's; the target paths are Task 7's). */
function runDays(
  list: DayList,
  days: number,
  count: number,
  learner: Learner = PHASE_37_LEARNER,
): { log: Asked[]; sessions: Session[]; introduced: Set<string>[]; knownIn: ReadonlyMap<string, number> } {
  // Phase 46 (spec D4): a fixture row at the bar has reached it on its last day, as the backfill dates it.
  const memory = new Map<string, MemoryRow>(
    list.memory.map((row) => [
      keyOf(row.glossId, row.dimension),
      { ...row, reachedOn: row.state.stability >= KNOWN_STABILITY ? row.state.lastDay : null },
    ]),
  );
  const progress = new Map<string, ProgressRow>(list.progress.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const met = new Set(list.memory.map((row) => row.glossId));
  /** Phase 39 (spec D2). The session each gloss was first seen known in: its known_at. */
  const knownIn = new Map<string, number>();
  const log: Asked[] = [];
  const sessions: Session[] = [];
  const introducedByDay: Set<string>[] = [];
  const { missEvery, phase = 0, forgets = new Set<string>() } = learner;
  let cards = phase;

  for (let day = 0; day < days; day++) {
    const date = dayAfter(list.today, day);
    const saved = list.saved.filter((gloss) => gloss.savedAt.slice(0, 10) <= date);
    const today: DayAnswer[] = [];
    const introduced = new Set<string>();
    introducedByDay.push(introduced);

    for (let session = 0; session < count; session++) {
      const at = sessions.length;
      const rows = [...memory.values()];
      const families = glossFamilies({
        saved: saved.map((gloss) => ({ ...gloss, knownAt: knownIn.has(gloss.glossId) ? `session ${knownIn.get(gloss.glossId)}` : null })),
        memory: rows,
        live: LIVE,
      });
      for (const glossId of families.newlyKnown) knownIn.set(glossId, at);
      const waiting = new Set([...families.state].filter(([, state]) => state === 'waiting').map(([glossId]) => glossId));

      const { steps, done } = dayState(today, introduced);
      const input: ChoiceInput = {
        saved,
        memory: rows,
        levels: [...progress.values()].map(({ glossId, dimension, level }) => ({ glossId, dimension, level })),
        today: date,
        steps,
        done,
        newToday: introduced.size,
        listening: true,
        speaking: true,
        rng: () => 0.5,
        families: { familyOf: families.familyOf, waiting, newMeanings: families.newMeanings },
      };
      const picks = chooseWords(input);
      sessions.push({ input, picks, families });
      const planned = picks.map((pick, i) => ({
        form: `w${i}`,
        translation: `מ${i}`,
        tiles: true,
        speakable: true,
        clozeGap: true,
        dimension: pick.dimension,
        rung: pick.rung,
        level: pick.level,
        r: pick.r,
        step: pick.cls === 'STEP',
        knownMeanings: families.introductions.get(pick.glossId),
        ladder: pick.ladder,
      }));
      const plan = planCards(planned, { listening: true, speaking: true });

      const given: AnsweredQuestion[] = plan.order.map((index, position) => {
        const pick = picks[index];
        const type = plan.types[position];
        // Phase 55 (spec D2, as ruled): an intro card is answered as one, as the app's answer is
        // stored against a question marked intro, so it grades nothing; and, writing nothing, it is
        // never missed and takes no turn in the rhythm, as a read aloud.
        const intro = plan.intro[position];
        const right = UNMISSED.has(type) || intro || (cards++ % missEvery !== missEvery - 1 && !forgets.has(pick.glossId));
        const { knownMeanings } = planned[index];
        log.push({ session, at, glossId: pick.glossId, cls: pick.cls, rung: pick.rung, type, right, knownMeanings, intro });
        return { ...answerOf(pick.glossId, type, right), intro };
      });

      const glossIds = [...new Set(given.map((answer) => answer.glossId))];
      const before = [...memory.values()].filter((row) => glossIds.includes(row.glossId));
      for (const row of applySession(before, given, date)) memory.set(keyOf(row.glossId, row.dimension), row);
      const levels = glossIds.flatMap((glossId) =>
        DIMENSIONS.map(
          (dimension) => progress.get(keyOf(glossId, dimension)) ?? { glossId, dimension, level: 1, lastStepOn: null, lastWrongOn: null },
        ),
      );
      for (const row of evaluateSession(levels, given, date).changed) progress.set(keyOf(row.glossId, row.dimension), row);
      for (const glossId of glossIds) {
        if (!met.has(glossId)) {
          met.add(glossId);
          introduced.add(glossId);
        }
      }
      today.push(...given.map((answer) => ({ ...answer, sessionId: `s${at}` })));
    }
  }
  return { log, sessions, introduced: introducedByDay, knownIn };
}

/** Outcome 6 (phase 39 D5): a family's glosses share one slot in a session. */
function expectOneGlossPerFamily(sessions: readonly Session[]) {
  sessions.forEach(({ picks, families }, at) => {
    const taken = picks.flatMap((pick) => (families.familyOf.has(pick.glossId) ? [families.familyOf.get(pick.glossId)] : []));
    expect({ at, families: taken.length }).toEqual({ at, families: new Set(taken).size });
  });
}

/** Outcome 7 (phase 39 D3, D5): a waiting gloss is no candidate. */
function expectNoWaitingGloss(sessions: readonly Session[]) {
  sessions.forEach(({ picks, families }, at) => {
    const waiting = picks.filter((pick) => families.state.get(pick.glossId) === 'waiting').map((pick) => pick.glossId);
    expect({ at, waiting }).toEqual({ at, waiting: [] });
  });
}

/** Outcomes 6 and 7 are not vacuous: the runner computed families, and some gloss
 *  waited in some session. False for a list of single-meaning words, which has none. */
function familiesChecked(sessions: readonly Session[]): { families: boolean; waited: boolean } {
  return {
    families: sessions.some(({ families }) => families.families.length > 0),
    waited: sessions.some(({ families }) => [...families.state.values()].includes('waiting')),
  };
}

/** Phase 54 (spec D4). Each session meets NEW_PER_SESSION ladders at most, and at least NEW_FLOOR
 *  words never met while some are left and the daily cap allows. And a session with room takes its
 *  ladders: while a word never met is left over, the daily cap allows another new word and the
 *  ceiling another ladder, fewer than LADDER_SLOTS of its slots go unused or to words the picker
 *  ranks after new ones (not due, or done today). For a list with no families and no shared keys,
 *  where every word never met is free to pick. */
function expectNewWordsEachSession(sessions: readonly Session[]) {
  sessions.forEach(({ input, picks }, at) => {
    const seen = new Set(input.memory.map((row) => row.glossId));
    const unmetLeft = input.saved.some((gloss) => !seen.has(gloss.glossId));
    const firstMeetings = picks.filter((pick) => pick.cls === 'NEW' && !seen.has(pick.glossId)).length;
    const ladders = picks.filter((pick) => pick.ladder).length;
    const picked = new Set(picks.map((pick) => pick.glossId));
    const ladderLeft =
      input.saved.some((gloss) => !seen.has(gloss.glossId) && !picked.has(gloss.glossId)) &&
      input.newToday + picks.filter((pick) => pick.cls === 'NEW').length < DAY_NEW_CAP &&
      ladders < NEW_PER_SESSION;
    const spare = SESSION_LENGTH - slotsOf(picks) + slotsOf(picks.filter((pick) => pick.cls === 'NOT_DUE' || pick.cls === 'DONE'));
    expect({
      at,
      ladders: ladders <= NEW_PER_SESSION,
      floor: !unmetLeft || input.newToday >= DAY_NEW_CAP || firstMeetings >= NEW_FLOOR,
      room: !ladderLeft || spare < LADDER_SLOTS,
    }).toEqual({ at, ladders: true, floor: true, room: true });
  });
}

/** Phase 55 (spec D2, D3). A ladder's cards in the spec's order, for a form that takes tiles and can
 *  be said in a session that can speak, as the runner plans every pick: written out here rather than
 *  read from plan.ts's ladderCards, so a plan that reorders them fails outcome 8. Its first
 *  LADDER_INTRO cards are the intro stage, one unit of the merge. */
const LADDER: readonly QuestionType[] = ['meet', 'read_aloud', 'letter_tiles', 'multiple_choice', 'reverse_choice', 'typed_translation'];
const LADDER_INTRO = 3;
/** The units a ladder's cards are merged as: its intro stage, then each practice card alone. */
const LADDER_UNITS = 1 + LADDER.length - LADDER_INTRO;

type Run = { log: readonly Asked[]; sessions: readonly Session[] };
/** The cards session `at` asked, in order, meet cards included. */
const cardsIn = (run: Run, at: number) => run.log.filter((card) => card.at === at);

/** Phase 54 (spec D2, D4). A gloss the session would ask as a ladder: no right answer in any skill
 *  (unlearned), not answered today, and no family's new meaning (phase 60, spec D1). */
function isLadder(glossId: string, input: ChoiceInput): boolean {
  return (
    !input.done.has(glossId) &&
    !input.families.newMeanings.has(glossId) &&
    !input.memory.some((row) => row.glossId === glossId && row.state.reps > row.state.lapses)
  );
}

/** Outcome 8 (phase 54, spec D2, D3; phase 55, spec D2, D3). A pick is a ladder exactly when its gloss
 *  is unlearned (no right answer in any skill), not done today and no family's introduction; a ladder
 *  is asked as LADDER, in that order, in its session, its intro stage back to back and its intro cards
 *  alone marked intro (as ruled); every other pick as one card, never a meet card nor an intro card.
 *  The run has ladders. */
function expectLadders(run: Run) {
  let ladders = 0;
  run.sessions.forEach(({ input, picks }, at) => {
    const cards = cardsIn(run, at);
    for (const { glossId, ladder } of picks) {
      const types = cards.filter((card) => card.glossId === glossId).map((card) => card.type);
      // Phase 55 (spec D3): the positions of its intro cards, which follow one another.
      const intro = cards.flatMap((card, position) => (card.glossId === glossId ? [position] : [])).slice(0, LADDER_INTRO);
      const backToBack = intro.every((position, k) => position === intro[0] + k);
      const marked = cards.filter((card) => card.glossId === glossId).map((card) => card.intro);
      expect({
        at,
        glossId,
        ladder,
        asked: ladder ? { types, backToBack, marked } : types.length === 1 && types[0] !== 'meet' && !marked[0],
      }).toEqual({
        at,
        glossId,
        ladder: isLadder(glossId, input),
        asked: ladder ? { types: LADDER, backToBack: true, marked: LADDER.map((_, k) => k < LADDER_INTRO) } : true,
      });
      if (ladder) ladders++;
    }
  });
  expect(ladders).toBeGreaterThan(0);
}

/** Phase 55 (spec D4). The cards that take no slot: a meet card, and a ladder's read aloud. The
 *  session's own speaking pick, a read aloud too, is another word's graded card. */
const freeCard = (card: Asked, ladders: ReadonlySet<string>) => card.type === 'meet' || (card.type === 'read_aloud' && ladders.has(card.glossId));

/** Outcome 9 (phase 54, spec D4; phase 55, spec D4). A session holds NEW_PER_SESSION ladders at most,
 *  and SESSION_LENGTH graded cards at most: every card but the free ones, one a slot, so a ladder's
 *  four graded cards are its LADDER_SLOTS. */
function expectSessionBounds(run: Run) {
  run.sessions.forEach(({ picks }, at) => {
    const ladderIds = new Set(picks.filter((pick) => pick.ladder).map((pick) => pick.glossId));
    const graded = cardsIn(run, at).filter((card) => !freeCard(card, ladderIds)).length;
    expect({ at, ladders: ladderIds.size <= NEW_PER_SESSION, graded: graded <= SESSION_LENGTH, perSlot: graded === slotsOf(picks) }).toEqual({
      at,
      ladders: true,
      graded: true,
      perSlot: true,
    });
  });
}

/** Outcome 10 (phase 54, spec D5; done means 1: "practised three times, never back to back"; phase 55,
 *  spec D3). No two cards of one word sit side by side while the session has another card to put
 *  between them, but inside a word's intro stage, whose cards are back to back by design (outcome 8).
 *  A lone ladder's LADDER_UNITS units (its intro stage and its three practice cards) need three others:
 *  with `others` non-ladder units (a board counts as one, a return as any other), at most
 *  max(0, 3 − others) of its cards outside its intro stage follow one of its own. With two ladders or
 *  more the stream's stage order always parts them: none does. Returns the sessions with a ladder and
 *  another card, each of them checked. */
function expectLaddersSpread(run: Run): number {
  let covered = 0;
  run.sessions.forEach(({ picks }, at) => {
    const ladders = picks.filter((pick) => pick.ladder).map((pick) => pick.glossId);
    if (ladders.length === 0 || picks.length === 1) return;
    covered++;
    const cards = cardsIn(run, at);
    const others =
      cards.filter((card) => !ladders.includes(card.glossId) && card.type !== 'matching').length + (cards.some((card) => card.type === 'matching') ? 1 : 0);
    const bound = ladders.length > 1 ? 0 : Math.max(0, LADDER_UNITS - 1 - others);
    // The k-th card of its word in the session: a ladder's cards 1 to LADDER_INTRO − 1 follow its own
    // inside the intro stage.
    const nth = cards.map((card, i) => cards.slice(0, i).filter((earlier) => earlier.glossId === card.glossId).length);
    const sideBySide = cards.flatMap((card, i) =>
      i > 0 && cards[i - 1].glossId === card.glossId && !(ladders.includes(card.glossId) && nth[i] < LADDER_INTRO) ? [card.glossId] : [],
    );
    const over = ladders.filter((glossId) => sideBySide.filter((pair) => pair === glossId).length > bound);
    expect({ at, others, over, unlisted: sideBySide.filter((glossId) => !ladders.includes(glossId)) }).toEqual({ at, others, over: [], unlisted: [] });
  });
  return covered;
}

/** Outcome 11 (phase 54, spec D2). A word whose ladder ended with every card that writes memory wrong
 *  is laddered again in a later session that day while its returns last: while the next session still
 *  owes it a return (today.ts: fewer than RETURNS_PER_DAY made). Phase 55 (spec D2, as ruled): the
 *  intro stage writes nothing, whatever its write-it card's answer (and this learner always says a
 *  read aloud right), so the three practice cards are the ones that count. Returns the ladders the
 *  check covered. */
function expectMissedLaddersAgain(run: Run): number {
  let covered = 0;
  run.sessions.forEach(({ input, picks }, at) => {
    const next = run.sessions[at + 1];
    if (next?.input.today !== input.today) return;
    for (const { glossId } of picks.filter((pick) => pick.ladder)) {
      const practice = cardsIn(run, at).filter((card) => card.glossId === glossId && !card.intro);
      if (practice.some((card) => card.right) || !next.input.steps.some((step) => step.glossId === glossId)) continue;
      covered++;
      const again = run.sessions
        .slice(at + 1)
        .some((later) => later.input.today === input.today && later.picks.some((pick) => pick.glossId === glossId && pick.ladder));
      expect({ at, glossId, again }).toEqual({ at, glossId, again: true });
    }
  });
  return covered;
}

/** Outcomes 8–11, phase 54's as phase 55 restates them, in a run. */
function itHoldsTheLadders(run: Run) {
  it('8. asks every unlearned word as a ladder: meet, read aloud and letter tiles back to back, then multiple choice, reverse choice, typed translation, in that order (phase 55)', () => {
    expectLadders(run);
  });

  it("9. holds a session to two ladders and ten graded cards, the meet and a ladder's read aloud free (phase 55)", () => {
    expectSessionBounds(run);
  });

  it('10. never puts two cards of one word side by side outside its intro stage while another card can go between them (phase 55)', () => {
    expect(expectLaddersSpread(run)).toBeGreaterThan(0);
  });

  it('11. ladders a word again later that day, while its returns last, when its ladder was all wrong (phase 54)', () => {
    // Phase 37's learner, missing one card in five, never misses all three practice cards of a ladder:
    // missed, they would sit five cards of its rhythm apart, ten from first to last, and a session has
    // ten graded cards. The learner who forgets a word, below, does.
    expectMissedLaddersAgain(run);
  });
}

/** A list, its sessions, what the day should meet in new words, and whether it has
 *  gloss families (phase 39). Phase 54 (spec D4): a new learner's list is all ladders, three a
 *  session at most (phase 55, spec D4: two), and the returns take slots too: the daily limit is out
 *  of reach in six sessions, so each session is held to the ceiling, the floor and its room instead. */
const DAYS: [string, DayList, number, (met: number, sessions: readonly Session[]) => void, boolean][] = [
  ['lane 0, the nine sessions of 2026-10-11', LANE0_DAY, LANE0_DAY.sessions, (met) => expect(met).toBeGreaterThan(2), true],
  ['lane 0 over twenty sessions', LANE0_DAY, 20, (met) => expect(met).toBe(DAY_NEW_CAP), true],
  ['a new learner, thirty words saved and none met, over six sessions', FRESH, 6, (_met, sessions) => expectNewWordsEachSession(sessions), false],
];

describe.each(DAYS)('a day: %s (phase 37)', (_name, list, count, checkMet, withFamilies) => {
  const {
    log,
    sessions,
    introduced: [introduced],
  } = runDays(list, 1, count);
  const last = count - 1;

  it('1. brings new words in every session while the daily limit allows', () => {
    for (const { input, picks } of sessions) {
      if (input.newToday < DAY_NEW_CAP) expect(picks.some((pick) => pick.cls === 'NEW')).toBe(true);
    }
    expect(introduced.size).toBeLessThanOrEqual(DAY_NEW_CAP);
  });

  it('2. recalls every word met before the last session later that day', () => {
    // Phase 54 (spec D2): a word's first NEW card meets it; a word missed in its ladder is NEW
    // again in a later session, and that card is its recall, as a return was.
    const met = log.filter(
      (card, i) => card.cls === 'NEW' && card.session < last && !log.slice(0, i).some((earlier) => earlier.glossId === card.glossId),
    );
    expect(met.length).toBeGreaterThan(0);
    for (const card of met) {
      const recalled = log.some((later) => later.glossId === card.glossId && later.session > card.session && later.rung === 2 && RECALL.has(later.type));
      expect({ glossId: card.glossId, recalled }).toEqual({ glossId: card.glossId, recalled: true });
    }
  });

  it('3. brings back every word missed before the last session later that day, until its returns run out', () => {
    const missed = log.filter((card) => !card.right && card.session < last);
    expect(missed.length).toBeGreaterThan(0);
    for (const card of missed) {
      // D1: a word comes back at most RETURNS_PER_DAY times a day. Returns follow every
      // card that is not a return (phase 54: a ladder's cards can go between them), late
      // in the session, where this learner misses the same places every session, so
      // some words use them all.
      const returns = log.filter((earlier) => earlier.glossId === card.glossId && earlier.cls === 'STEP' && earlier.session <= card.session);
      if (returns.length >= RETURNS_PER_DAY) continue;
      const back = log.some((later) => later.glossId === card.glossId && later.session > card.session);
      expect({ glossId: card.glossId, session: card.session, back }).toEqual({ glossId: card.glossId, session: card.session, back: true });
    }
  });

  it('4. gives a session a speaking card whenever a word met is not owed a return', () => {
    // Before then there is nothing to say: the first session meets the words, and a
    // new learner's second owes each of them its return.
    sessions.forEach(({ input }, session) => {
      const owed = new Set(input.steps.map((step) => step.glossId));
      if (input.done.size === 0 && input.memory.every((row) => owed.has(row.glossId))) return;
      const spoke = log.some((card) => card.session === session && SPEAKING_CARDS.has(card.type));
      expect({ session, spoke }).toEqual({ session, spoke: true });
    });
  });

  it('5. asks a word done today only when no other word can be asked', () => {
    for (const { input, picks } of sessions) {
      if (!picks.some((pick) => pick.cls === 'DONE')) continue;
      // Every word the session could ask besides the done ones was asked. Phase 54 (spec D4): the
      // slot the speaking pick gave a word done today (phase 37 D4) was no other word's, so the
      // session without them is that much shorter: a ladder that fits only there was no word to ask.
      const spokeDone = picks.filter((pick) => pick.cls === 'SPEAK' && input.done.has(pick.glossId)).length;
      const [others] = choosePools({ ...input, saved: input.saved.filter((gloss) => !input.done.has(gloss.glossId)), done: new Set() }, [
        { glossIds: null, slots: SESSION_LENGTH - spokeDone, owedNew: 0 },
      ]);
      const asked = new Set(picks.map((pick) => pick.glossId));
      expect(others.map((pick) => pick.glossId).filter((glossId) => !asked.has(glossId))).toEqual([]);
    }
  });

  it('6 and 7 have families to check, and a gloss that waits, when the list has them (phase 39)', () => {
    expect(familiesChecked(sessions)).toEqual({ families: withFamilies, waited: withFamilies });
  });

  it('6. never asks two glosses of one family in a session (phase 39)', () => {
    expectOneGlossPerFamily(sessions);
  });

  it('7. never asks a waiting gloss (phase 39)', () => {
    expectNoWaitingGloss(sessions);
  });

  it('meets new words as the list allows: lane 0 up to the daily limit, the new learner two a session at most and one at least; and recalls', () => {
    checkMet(introduced.size, sessions);
    expect(log.some((card) => card.rung === 2 && RECALL.has(card.type))).toBe(true);
  });

  itHoldsTheLadders({ log, sessions });
});

/** Phase 54 (done means 1, spec §2). The new learner's thirty words over days: three days meet them
 *  all (13, 9 and 8 words), and a fourth keeps a day's drift from turning the test red.
 *
 *  Phase 55 (spec D4, as ruled): two ladders a session meet fewer words a day, so four days meet them
 *  all (9, 8, 7 and 6 words), and a fifth keeps the drift. Over the rhythm's five phases, phase 54's
 *  code meets them in three days at every phase (13 10 7, 13 10 7, 13 9 8, 13 9 8, 13 10 7); this
 *  phase's in four at four phases (9 8 7 6, 9 7 8 6, 9 8 8 5, 9 8 7 6) and in five at the fifth
 *  (9 7 7 6 1). Measured 2026-10-16. */
describe('a new learner over days: thirty words saved and none met, five days of six sessions (phase 54, phase 55)', () => {
  const run = runDays(FRESH, 5, 6);

  it('meets all thirty words, each with a meet card before any other card, two a session at most', () => {
    expect(new Set(run.introduced.flatMap((day) => [...day])).size).toBe(FRESH.saved.length);
    for (const { glossId } of FRESH.saved) {
      expect({ glossId, first: run.log.find((card) => card.glossId === glossId)?.type }).toEqual({ glossId, first: 'meet' });
    }
    run.sessions.forEach(({ input, picks }, at) => {
      const firsts = picks.filter((pick) => !input.memory.some((row) => row.glossId === pick.glossId)).length;
      expect({ at, firsts: firsts <= NEW_PER_SESSION }).toEqual({ at, firsts: true });
    });
  });

  it('meets a word in every session while some are left and the daily cap allows, and takes its ladders while it has room', () => {
    expectNewWordsEachSession(run.sessions);
  });

  itHoldsTheLadders(run);
});

/** Phase 54 (spec D2). Phase 37's learner, but with one word it never gets right: every card of the
 *  newest saved word that asks something is wrong. Being the newest, the first session meets it.
 *  Phase 55 (spec D2): its ladder's read aloud is said right, as every read aloud is here, and writes
 *  no memory, so the word is still unlearned after it. */
const FORGOTTEN = 'n29';

describe("a new learner who forgets a word: the thirty words over six sessions, every card of the newest wrong (phase 54)", () => {
  const run = runDays(FRESH, 1, 6, { ...PHASE_37_LEARNER, forgets: new Set([FORGOTTEN]) });

  it('ladders the forgotten word again later that day while its returns last, never as a cold recall card', () => {
    // Outcome 11 has ladders to check here: the forgotten word's.
    expect(expectMissedLaddersAgain(run)).toBeGreaterThan(0);
    const asked = run.sessions.flatMap(({ picks }, at) => picks.filter((pick) => pick.glossId === FORGOTTEN).map(({ cls, ladder }) => ({ at, cls, ladder })));
    expect(asked[0]).toEqual({ at: 0, cls: 'NEW', ladder: true });
    const again = asked.filter(({ at, ladder }) => at > 0 && ladder);
    expect({ again: again.length > 0 && again.length <= RETURNS_PER_DAY, steps: asked.filter(({ cls }) => cls === 'STEP') }).toEqual({ again: true, steps: [] });
  });

  itHoldsTheLadders(run);
});

/** A word of five meanings, most common first. */
const FIVE = ['m0', 'm1', 'm2', 'm3', 'm4'];

/** Phase 39 (spec D12). Twelve glosses saved one morning: a word of five meanings, a
 *  homograph pair that shares a spelling (see / saw), and five single words. */
const FAMILIES: DayList = {
  today: '2026-10-12',
  saved: [
    ...FIVE.map((glossId, i) => ({
      glossId,
      key: `five-${i}`,
      savedAt: `2026-10-12T08:00:0${i}.000000Z`,
      lexemeId: 'x-five',
      lemma: 'x-five',
      forms: ['f-five'],
      order: [0, i] as const,
      speakable: true,
    })),
    { glossId: 'h0', key: 'see', savedAt: '2026-10-12T08:01:00.000000Z', lexemeId: 'x-see', lemma: 'x-see', forms: ['f-saw', 'f-see'], order: [0, 0], speakable: true },
    { glossId: 'h1', key: 'saw', savedAt: '2026-10-12T08:01:01.000000Z', lexemeId: 'x-saw', lemma: 'x-saw', forms: ['f-saw'], order: [1, 0], speakable: true },
    ...Array.from({ length: 5 }, (_, i) => ({
      glossId: `s${i}`,
      key: `single-${i}`,
      savedAt: `2026-10-12T08:02:0${i}.000000Z`,
      lexemeId: `x-single-${i}`,
      lemma: `x-single-${i}`,
      forms: [`f-single-${i}`],
      order: [0, 0] as const,
      speakable: true,
    })),
  ],
  memory: [],
  progress: [],
};

describe('families over days: twenty-five days of six sessions, phase 37\'s learner (phase 39, phase 46)', () => {
  // Phase 46 (spec D6). Under phase 39's rule, every skill at the bar at the same moment, phase
  // 37's learner never got a gloss of this list known: a miss drops the skill it tests, and at six
  // sessions a day each of the seven glosses not waiting is missed about once a day. A skill now
  // counts once it has reached the bar (D1, D2), so the second meanings come. The five-meaning
  // word, asked in every session, is known on day 20 (session 118); five more days keep the test
  // from turning red on a day's drift.
  //
  // Phase 54. Whether a word is known in the run depends on which card of five the learner misses:
  // in sessions of ten graded cards it misses the same places in every session, and the word asked
  // there (the plan asks the weakest word late, and the returns after every other card but a
  // ladder's) is missed again each time, its skill never reaching the bar. Ladders change how many
  // cards day 0 asks, which moves those places. So the two meaning outcomes are checked for the
  // learner at each of the five places in its rhythm: wherever the first meaning is known, the
  // second follows as a new_meaning; wherever it is not, no other meaning is asked; some place
  // knows the first. Which word a place keeps missing moves with the rhythm, so how often words
  // come to be known is counted over the whole list, against phase 53's code (KNOWN_ON_PHASE_53).
  const runs = EVERY_PHASE.map((learner) => runDays(FAMILIES, 25, 6, learner));
  const [{ log, sessions }] = runs;

  /** The seven glosses that do not wait: each word's current meaning, the five-meaning word's and
   *  the shared spelling's first, and the five single words. */
  const FREE = ['m0', 'h0', 's0', 's1', 's2', 's3', 's4'];

  /** As ruled: the (gloss, phase) pairs of FREE known within the 25 days, over the five phases. Phase
   *  53's code (origin/master a182c99a, this runner and learner) knows 11 (m0 3, h0 3, s0 3, s4 2);
   *  phase 54 knows 14 (m0 3, h0 1, s0–s4 2 each). Over learners missing every 4th to 8th card, all
   *  their phases: m0 21 → 19 of 30, h0 22 → 20 of 30, the single words 68 → 94 of 150.
   *  Phase 55 knows 11 (m0 1, h0 2, s0 3, s3 2, s1 s2 s4 1 each; measured 2026-10-16), and over the
   *  learners missing every 4th to 8th card 129 of 210 to phase 54's 133. With phase 54's three
   *  ladders a session it knows phase 54's 14 and 133 exactly: the intro stage, writing nothing and
   *  missed never, leaves this list as it was, and the drop is two ladders a session (spec D4), which
   *  spread the first meetings of its seven words over more of the first day's sessions. */
  const KNOWN_ON_PHASE_53 = 11;

  it('6 and 7 have families to check, and a gloss that waits', () => {
    expect(familiesChecked(sessions)).toEqual({ families: true, waited: true });
  });

  it('6. never asks two glosses of one family in a session', () => {
    expectOneGlossPerFamily(sessions);
  });

  it('7. never asks a waiting gloss', () => {
    expectNoWaitingGloss(sessions);
  });

  itHoldsTheLadders({ log, sessions });

  /** In every phase's run: `first` is asked before any other meaning of its word; until it is known,
   *  none is asked; once it is, the first asked is `second`, at or after the session it was known in.
   *  And some phase knows `first` within the run, so the outcome is tested. */
  function expectSecondOnceKnown(first: string, others: readonly string[], second: Partial<Asked>) {
    expect({ first, knownAtSomePhase: runs.some(({ knownIn }) => knownIn.has(first)) }).toEqual({ first, knownAtSomePhase: true });
    runs.forEach(({ log: asked, knownIn }, phase) => {
      const word = asked.filter((card) => card.glossId === first || others.includes(card.glossId));
      expect({ phase, first: word[0]?.glossId }).toEqual({ phase, first });
      const next = word.find((card) => card.glossId !== first);
      const knownAt = knownIn.get(first);
      if (knownAt === undefined) expect({ phase, next }).toEqual({ phase, next: undefined });
      else expect({ phase, ...next, afterKnown: next !== undefined && next.at >= knownAt }).toMatchObject({ phase, ...second, afterKnown: true });
    });
  }

  it("asks a word's second meaning once its first is known, first as a new_meaning that lists the first, whichever card of five the learner misses", () => {
    // The most common meaning is the word's first (D3).
    expectSecondOnceKnown('m0', FIVE.slice(1), { glossId: 'm1', type: 'new_meaning', knownMeanings: ['five-0'] });
  });

  it('asks the other reading of a shared spelling the same way, whichever card of five the learner misses', () => {
    expectSecondOnceKnown('h0', ['h1'], { glossId: 'h1', type: 'new_meaning', knownMeanings: ['see'] });
  });

  it('never meets a new meaning after its new_meaning card, though the learner misses every card of it (phase 60, spec D1)', () => {
    // The second meanings always missed, at each place of the rhythm: a missed new_meaning
    // leaves the gloss unlearned, which phase 54 alone would ladder.
    const forgets = new Set(['m1', 'h1']);
    const missed = EVERY_PHASE.map((learner) => runDays(FAMILIES, 25, 6, { ...learner, forgets }).log);
    const after = missed.flatMap((asked) =>
      asked.filter((card, at) => asked.slice(0, at).some((prior) => prior.glossId === card.glossId && prior.type === 'new_meaning')),
    );
    // The check can fire: some new meaning is asked again after its new_meaning card.
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((card) => card.type === 'meet' || card.intro)).toEqual([]);
  });

  const known = runs.flatMap(({ knownIn }) => FREE.filter((glossId) => knownIn.has(glossId))).length;

  it(`gets the list's words known as often as phase 53 did, over the five phases: ${known} of ${FREE.length * runs.length} (pass ≥ ${KNOWN_ON_PHASE_53}) (phase 46)`, () => {
    // FREE is what waits on nothing when the run starts.
    expect(FAMILIES.saved.map(({ glossId }) => glossId).filter((glossId) => sessions[0].families.state.get(glossId) !== 'waiting')).toEqual(FREE);
    expect(known).toBeGreaterThanOrEqual(KNOWN_ON_PHASE_53);
  });
});

// Phase 53 (spec §2): the day simulation with targets. Phase 57 (spec §7): each target on a path of
// its own (D1), its sessions its own picker's (D7), the learner following home (D11).

const SESSIONS_A_DAY = 6;

/** A learner who answers every card right. */
const NEVER_MISSES = Number.POSITIVE_INFINITY;

/** Phase 53 (spec §2), phase 57 (spec §7). The share of a list ready by FSRS on its due date (recall
 *  on the date in its weakest live skill at TARGET_READY, the recorded yardstick of spec D9), phase
 *  37's learner, the mean over the five phases of its miss rhythm, for the 14-day scenarios. Never
 *  lowered to let a change pass (spec §7). */
const READY_ON_DUE_PASS: Record<TargetKind, number> = {
  // Phase 53's 0.65 was one phase, at the rhythm's best: its five phases average 0.57 (0.65 0.65 0.55
  // 0.40 0.60). Phase 54 measured 0.58 (0.70 0.50 0.60 0.60 0.50), phase 55 0.58 (0.65 0.50 0.60 0.50
  // 0.65), both from the split session. Phase 57, each target on its own path with TARGET_CAP_HALVES
  // as first set: 0.60 (0.60 0.55 0.50 0.65 0.70; measured 2026-10-16).
  exam: 0.57,
  // Measured 2026-10-15 at the first phase alone: 0.85; phase 54 0.90, phase 55 0.90 (measured
  // 2026-10-16). Phase 57 (spec §7, as ruled): the mean over the five phases, as the exam's: 0.92
  // (0.90 0.90 0.90 0.95 0.95; measured 2026-10-16).
  homework: 0.85,
};

const listId = (n: number) => `t${String(n).padStart(2, '0')}`;
/** Words `from` to `to` of the list. */
const listIds = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => listId(from + i));

/** A word of a target's list, saved on `day` (the day it joined its target, as the wizard and the
 *  target screen save it), never met, the only meaning of its word. `glossId` names it otherwise. */
const listWord = (n: number, day: number, glossId = listId(n)): Omit<FamilyGloss, 'knownAt'> => ({
  glossId,
  key: `list-${n}`,
  savedAt: `${dayAfter(LANE0_DAY.today, day)}T18:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000000Z`,
  lexemeId: `x-list-${n}`,
  lemma: `x-list-${n}`,
  forms: [`f-list-${n}`],
  order: [0, 0],
  speakable: true,
});

/** Lane 0's list of 2026-10-11 as the main path, `words` list words saved on its first day, and
 *  `later.words` more saved on day `later.on`. */
function withList(words: number, later = { words: 0, on: 0 }): DayList {
  return {
    today: LANE0_DAY.today,
    saved: [
      ...LANE0_DAY.saved,
      ...Array.from({ length: words }, (_, i) => listWord(i + 1, 0)),
      ...Array.from({ length: later.words }, (_, i) => listWord(words + i + 1, later.on)),
    ],
    memory: LANE0_DAY.memory,
    progress: LANE0_DAY.progress,
  };
}

/** The date `days` days after the lists' first day. */
const dueIn = (days: number) => dayAfter(LANE0_DAY.today, days);
const LANE0_GLOSSES: ReadonlySet<string> = new Set(LANE0_DAY.saved.map((gloss) => gloss.glossId));
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** A target as a day of the run holds it: its kind, the day it was created, its due date and its
 *  words, each with the day it joined. */
type SimTarget = {
  id: string;
  kind: TargetKind;
  createdOn: string;
  dueOn: string;
  words: readonly { glossId: string; addedOn: string }[];
};

/** A target created on the lists' first day and due `days` later, holding `glossIds` from then. */
const targetOf = (kind: TargetKind, days: number, glossIds: readonly string[]): SimTarget => ({
  id: kind,
  kind,
  createdOn: dueIn(0),
  dueOn: dueIn(days),
  words: glossIds.map((glossId) => ({ glossId, addedOn: dueIn(0) })),
});

/** What the learner answered: right, wrong (gave up, for a say translation), or one of the
 *  2026-10-16 replay's misses. */
type Verdict = 'right' | 'wrong' | 'near_miss' | 'gave_up';
/** A card of a run on paths: `path` is its target's id, null for My words; `date`, its day's. */
type PathAsked = Asked & { path: string | null; verdict: Verdict; date: string };
/** Phase 37's learner, with `scripted` misses: the verdict for a card the learner answers otherwise
 *  than its rhythm says, given its day and the cards before it in the run; undefined to follow the
 *  rhythm. */
type PathLearner = Learner & {
  scripted?: (card: { glossId: string; type: QuestionType; date: string }, earlier: readonly PathAsked[]) => Verdict | undefined;
};

/** The sessions a day: a number, or `untilDone`: sessions while some target has work owed (D11's
 *  first card a target's), at most that many, for a learner who practises until the day is done. */
type SessionsOn = number | { untilDone: number };

/** A session of a run on paths. `home`: each active target's day as home read it before the
 *  session (spec D11); `path`: the target whose card was first, null for My words; `mode`, the
 *  target picker's (ruling T3-m: practice more when owed work returns no pick); `input` and
 *  `families`, My words' choice. */
type PathSession = {
  at: number;
  day: number;
  date: string;
  path: string | null;
  home: ReadonlyMap<string, TargetDay>;
  mode: TargetMode | null;
  picks: ChosenPick[];
  input: ChoiceInput | null;
  families: Families | null;
  /** Phase 65 (spec D7.1): a target session's budget for its day, as read at its start; null for
   *  My words. */
  budget: number | null;
  /** Phase 65 (spec D1): each active target's readiness before the session and after it. */
  readiness: { before: ReadonlyMap<string, TargetReadiness>; after: ReadonlyMap<string, TargetReadiness> };
};

/** Phase 65 (spec D1, R1). A target's readiness as its summary reads it (targetSummary.ts
 *  readinessSummary): the grade its words would get on `dueOn`, and each word's chance, in percent
 *  rounded down. */
type TargetReadiness = { kind: TargetKind; dueOn: string; pct: number; words: ReadonlyMap<string, number> };

/** Phase 65 (spec D7.1). A budget as the run set it, before session `at`, with `daysLeft` to the
 *  date: `sessions` promised for the day. */
type SimBudget = { targetId: string; date: string; at: number; daysLeft: number; sessions: number };

/** A day of a run on paths: the sessions played, the memory before the first (the memory the day
 *  before left), and each active target's day before the first session and after the last; and
 *  (phase 65) its readiness then. */
type PathDay = {
  date: string;
  played: number;
  memory: readonly MemoryRow[];
  start: ReadonlyMap<string, TargetDay>;
  end: ReadonlyMap<string, TargetDay>;
  readiness: { start: ReadonlyMap<string, TargetReadiness>; end: ReadonlyMap<string, TargetReadiness> };
};

type PathRun = {
  sessions: PathSession[];
  log: PathAsked[];
  days: PathDay[];
  events: TargetSkillEvent[];
  /** `${targetId}|${glossId}` → the day the word started on the target (spec D6). */
  startedOn: ReadonlyMap<string, string>;
  /** Phase 65 (spec D7.1): every budget the run set, in order. */
  budgets: SimBudget[];
  /** Phase 65 (spec D2): every readiness line the session ends wrote. */
  readinessEvents: TargetReadinessEvent[];
};

function pathAnswer(glossId: string, type: QuestionType, verdict: Verdict): AnsweredQuestion {
  if (verdict === 'right' || verdict === 'wrong') return answerOf(glossId, type, verdict === 'right');
  return { glossId, type, verdict } as AnsweredQuestion;
}

/**
 * Phase 57 (spec D1, D4, D6, D7, D11). `days` days over `list` and its `targets` (a target is active
 * from its creation through its due date, D10), each session the first card home shows: a target
 * with work owed today, the nearest due date first, else My words. Each session is ended as
 * recordProgress ends one.
 *
 * A target's session is chooseTargetPicks' over its day (targetDay), read as the session service
 * reads it (services/sessions.ts readTarget, services/targetDayRead.ts): the skills answered right
 * today from every path's non-intro answers, practised today when its own path was, known when the
 * word has FSRS memory, started on the day of the first session that asks it after it joined (any
 * answer, ruling T4-e), practice more when owed work returns no pick (T3-m), and room for the day's
 * new words, DAY_NEW_CAP less those met today (T3-n); planned with the target flag (T3-l). My words
 * is chooseWords over the saved words in no active target, its families over every saved word
 * (T5-k), its new words counting every path's first meetings today (D8). Every session writes FSRS
 * memory and levels as before (Done 1), and the target skills of every active target holding a word
 * it asked through targetSessionWrite (D4). Sessions run one after another.
 *
 * `stockLag` (spec D2, final review C1): a target's session is the stock its path's previous
 * session chose at its start, crediting that session's graded cards as right (ruling T3-j), its
 * room for new words less that session's first meetings (T3-n), as the stock job builds it
 * beside a started session; the first of a path is built by create, with nothing in flight.
 * Before it is played, a stock that stockToCheck holds (chosen on an earlier day, or as practice
 * more) is replaced by today's choice when stockServes says it no longer serves it, as create
 * does (services/sessions.ts replaceIfStale). Without it, every target session is chosen when it
 * is played, with nothing in flight.
 *
 * Phase 65 (spec D2, D7.1, D11, R1). Every session end writes the readiness of every active target
 * holding a word it asked (readinessSessionWrite) from the main memory as it stood before that
 * session's own write, and each target's readiness is read before and after every session, at the
 * start of every day and at its end, as the target summary reads it. A target's budget for the day
 * is set before its path's first session that day (readTodayBudget's: the picker played forward
 * from the day as it stands, stretched for the miss rate of the last MISS_RATE_DAYS days with
 * answers, ruling T5-b; none of the path's sessions done yet), and its later sessions read it. The
 * learner plays as before: the budget changes no session.
 */
function runPaths(
  list: DayList,
  days: number,
  sessionsADay: SessionsOn | ((day: number) => SessionsOn),
  targets: readonly SimTarget[] | ((day: number) => readonly SimTarget[]),
  learner: PathLearner = PHASE_37_LEARNER,
  { stockLag = false }: { stockLag?: boolean } = {},
): PathRun {
  const targetsOn = typeof targets === 'function' ? targets : () => targets;
  const sessionsOn = typeof sessionsADay === 'function' ? sessionsADay : () => sessionsADay;
  const memory = new Map<string, MemoryRow>(
    list.memory.map((row) => [
      keyOf(row.glossId, row.dimension),
      { ...row, reachedOn: row.state.stability >= KNOWN_STABILITY ? row.state.lastDay : null },
    ]),
  );
  const progress = new Map<string, ProgressRow>(list.progress.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const met = new Set(list.memory.map((row) => row.glossId));
  const knownIn = new Map<string, number>();
  const skills = new Map<string, TargetSkillRow>();
  const startedOn = new Map<string, string>();
  const events: TargetSkillEvent[] = [];
  const log: PathAsked[] = [];
  const sessions: PathSession[] = [];
  const record: PathDay[] = [];
  /** Phase 65: readiness rows by `${targetId}|${glossId}|${dimension}`, and their lines. */
  const readinessRows = new Map<string, TargetReadinessRow>();
  const readinessEvents: TargetReadinessEvent[] = [];
  /** Phase 65: each target day's budget by `${targetId}|${date}`, and every one set, in order. */
  const budgets = new Map<string, SimBudget>();
  const budgetsSet: SimBudget[] = [];
  const { missEvery, phase = 0, forgets = new Set<string>(), scripted } = learner;
  let cards = phase;
  /** A target choice: its picks and mode, and what its stock records of the day (session_targets);
   *  `meanings`, the known meanings choosePicks gives a family's new meaning it starts (phase 60). */
  type Choice = {
    picks: ChosenPick[];
    mode: TargetMode;
    chosenOn: string;
    recorded: StockChoice;
    meanings: ReadonlyMap<string, readonly string[]>;
  };
  /** Each target path's stock, with stockLag: chosen at its previous session's start. */
  const stocks = new Map<string, Choice>();

  for (let day = 0; day < days; day++) {
    const date = dayAfter(list.today, day);
    const saved = list.saved.filter((gloss) => gloss.savedAt.slice(0, 10) <= date);
    const today: DayAnswer[] = [];
    const pathOf = new Map<string, string | null>();
    const introduced = new Set<string>();
    const active = targetsOn(day).filter((target) => activeOn({ endedAt: null, dueOn: target.dueOn }, date));
    const wordsOf = (target: SimTarget) => target.words.filter((word) => word.addedOn <= date);

    /** Spec D6, D9, phase 67 (spec D1, D2): what readTargetDay reads the target's day from (phase
     *  65: the budget's play moves on from it): its words, each counted skill's readiness at the
     *  start of today (its first line today's before, else its row, else the main memory), and the
     *  cards asked today on its path; and the day. */
    const dayInputOf = (target: SimTarget): TargetDayInput => {
      const words = wordsOf(target).map(({ glossId, addedOn }) => ({
        glossId,
        addedOn,
        startedOn: startedOn.get(`${target.id}|${glossId}`) ?? null,
        live: LIVE,
      }));
      const own = new Set(words.map((word) => word.glossId));
      const firstToday = new Map<string, { glossId: string; dimension: Dimension; before: number }>();
      for (const event of readinessEvents) {
        const key = keyOf(event.glossId, event.dimension);
        if (event.targetId === target.id && event.day === date && !firstToday.has(key)) {
          firstToday.set(key, { glossId: event.glossId, dimension: event.dimension, before: event.before });
        }
      }
      const onPath = today.filter((answer) => pathOf.get(answer.sessionId) === target.id);
      return {
        today: date,
        createdOn: target.createdOn,
        dueOn: target.dueOn,
        kind: target.kind,
        words,
        starts: skillStarts({
          kind: target.kind,
          dueOn: target.dueOn,
          words,
          rows: [...readinessRows.values()].filter((row) => row.targetId === target.id),
          memory: [...memory.values()].filter((row) => own.has(row.glossId)),
          firstToday: [...firstToday.values()],
        }),
        askedToday: onPath.map((answer) => ({ glossId: answer.glossId, type: answer.type })),
        answeredToday: onPath.length > 0,
      };
    };
    const dayOf = (target: SimTarget): TargetDay => targetDay(dayInputOf(target));
    const homeNow = () => new Map(active.map((target) => [target.id, dayOf(target)]));
    /** Spec D4, phase 65 (D2): the targets a session's answers count for, as recordProgress reads them. */
    const holding: HoldingTarget[] = active.map((one) => ({
      id: one.id,
      dueOn: one.dueOn,
      kind: one.kind,
      words: wordsOf(one).map(({ glossId, addedOn }) => ({ glossId, addedAt: `${addedOn}T00:00:00.000000Z` })),
    }));
    /** Phase 65 (spec D1, R1): the target's readiness as targetSummary reads it, every word's skills
     *  live (the device records, and every list word can be said). */
    const readinessFor = (target: SimTarget): TargetReadiness => {
      const glossIds = new Set(wordsOf(target).map((word) => word.glossId));
      const summary = readinessSummary({
        kind: target.kind,
        dueOn: target.dueOn,
        today: date,
        words: [...glossIds].map((glossId) => ({ glossId, live: LIVE })),
        rows: [...readinessRows.values()].filter((row) => row.targetId === target.id),
        memory: [...memory.values()].filter((row) => glossIds.has(row.glossId)),
        firstToday: [],
      });
      return {
        kind: target.kind,
        dueOn: target.dueOn,
        pct: summary.readinessPct,
        words: new Map(summary.words.map((word) => [word.glossId, word.readinessPct])),
      };
    };
    const readinessNow = () => new Map(active.map((target) => [target.id, readinessFor(target)]));
    /** Phase 39: every saved gloss's families, the known stamps as My words left them. */
    const familiesNow = () =>
      glossFamilies({
        saved: saved.map((gloss) => ({ ...gloss, knownAt: knownIn.has(gloss.glossId) ? `session ${knownIn.get(gloss.glossId)}` : null })),
        memory: [...memory.values()],
        live: LIVE,
      });
    /** services/targetDayRead.ts readTargetPickInput: the picker's input beside its path's session
     *  in flight, whose graded cards it credits, and the day's room for new words less its first
     *  meetings (T3-n). */
    const pickInputOf = (
      target: SimTarget,
      inFlight: readonly { glossId: string; type: QuestionType; intro: boolean }[],
      families: Families = familiesNow(),
    ): TargetPickInput => {
      const day = dayOf(target);
      const own = new Set(wordsOf(target).map((word) => word.glossId));
      const meeting = new Set(inFlight.map((card) => card.glossId).filter((glossId) => own.has(glossId) && !met.has(glossId)));
      return {
        day,
        mode: targetMode(day),
        levels: new Map([...progress.values()].map((row) => [`${row.glossId}|${row.dimension}`, row.level])),
        known: new Set([...memory.values()].map((row) => row.glossId)),
        newMeanings: families.newMeanings,
        keys: new Map(saved.map((gloss) => [gloss.glossId, gloss.key])),
        inFlight: inFlight.filter((card) => !card.intro),
        newRoom: Math.max(0, DAY_NEW_CAP - introduced.size - meeting.size),
      };
    };
    /** services/sessions.ts readTarget: the target's choice beside its path's session in flight,
     *  past the day's budget the owed work and then practice more (phase 65b D2), practice more when
     *  owed work returns no pick (T3-m); a family's new meaning started with its
     *  known meanings, no ladder (phase 60, spec D1). */
    const chooseFor = (target: SimTarget, inFlight: readonly { glossId: string; type: QuestionType; intro: boolean }[]): Choice => {
      const families = familiesNow();
      const pickInput = pickInputOf(target, inFlight, families);
      const { day } = pickInput;
      let mode = pickInput.mode;
      // Phase 65b (spec D2): past the day's budget a session asks the owed work, then practice
      // more. The path's sessions so far today include the one in flight when a stock is built
      // beside it, so none is counted twice.
      const set = budgets.get(`${target.id}|${date}`);
      const played = sessions.filter((one) => one.path === target.id && one.date === date).length;
      if (mode === 'owed' && pastBudget({ budget: set?.sessions ?? null, done: played, inFlight: false })) mode = 'past_budget';
      let picks = chooseTargetPicks({ ...pickInput, mode });
      if (picks.length === 0 && mode === 'owed') {
        mode = 'more';
        picks = chooseTargetPicks({ ...pickInput, mode });
      }
      const meanings = new Map(
        picks.flatMap((pick) => {
          const known = pick.cls === 'NEW' && !pick.ladder ? families.introductions.get(pick.glossId) : undefined;
          return known ? [[pick.glossId, known] as const] : [];
        }),
      );
      return { picks, mode, chosenOn: date, recorded: { capHalves: day.capHalves, owedGlossIds: owedWords(day, mode) }, meanings };
    };
    /** services/sessions.ts createNextSession: the path's stock, replaced when stale; else built. */
    const nextOf = (target: SimTarget): Choice => {
      const stock = stockLag ? stocks.get(target.id) : undefined;
      stocks.delete(target.id);
      if (!stock) return chooseFor(target, []);
      if (!stockToCheck({ chosenOn: stock.chosenOn, owedGlossIds: stock.recorded.owedGlossIds }, date)) return stock;
      const fresh = chooseFor(target, []);
      return stockServes(stock.recorded, fresh.recorded) || fresh.picks.length === 0 ? stock : fresh;
    };
    /** Phase 65 (spec D7.1, ruling T3-a), phase 67 (spec D5): services/targetDayRead.ts
     *  readTodayBudget before the path's first session of the day, so none of its sessions is done
     *  yet (doneBefore 0): the picker played forward, which is the day. */
    const budgetFor = (target: SimTarget, at: number): SimBudget => {
      const play = playTodayForward({ pick: pickInputOf(target, []), ...dayInputOf(target) });
      return { targetId: target.id, date, at, daysLeft: daysBetween(date, target.dueOn), sessions: play.sessions };
    };
    const start = homeNow();
    const readinessStart = readinessNow();
    const memoryAtStart = [...memory.values()];
    const plan = sessionsOn(day);
    const max = typeof plan === 'number' ? plan : plan.untilDone;
    let played = 0;

    for (let session = 0; session < max; session++) {
      const at = sessions.length;
      const home = homeNow();
      // Spec D11: the targets with work owed today, the nearest due date first, then My words.
      const owed = active
        .filter((target) => home.get(target.id)!.state === 'owed')
        .sort((a, b) => compare(a.dueOn, b.dueOn) || compare(a.id, b.id));
      if (typeof plan !== 'number' && owed.length === 0) break;
      const target: SimTarget | undefined = owed[0];
      const rows = [...memory.values()];
      let picks: ChosenPick[];
      let mode: TargetMode | null = null;
      let owedRecorded: readonly string[] = [];
      let input: ChoiceInput | null = null;
      let families: Families | null = null;
      let meanings: ReadonlyMap<string, readonly string[]> = new Map();
      let budget: number | null = null;
      if (target) {
        // Phase 65 (spec D7.1): set once, at the path's first session of the day; a later one reads it.
        const key = `${target.id}|${date}`;
        if (!budgets.has(key)) {
          const set = budgetFor(target, at);
          budgets.set(key, set);
          budgetsSet.push(set);
        }
        budget = budgets.get(key)!.sessions;
        let recorded: StockChoice;
        ({ picks, mode, meanings, recorded } = nextOf(target));
        owedRecorded = recorded.owedGlossIds;
      } else {
        families = familiesNow();
        for (const glossId of families.newlyKnown) knownIn.set(glossId, at);
        const waiting = new Set([...families.state].filter(([, state]) => state === 'waiting').map(([glossId]) => glossId));
        const held = new Set(active.flatMap((one) => wordsOf(one).map((word) => word.glossId)));
        const { steps, done } = dayState(today, introduced);
        input = {
          saved: saved.filter((gloss) => !held.has(gloss.glossId)),
          memory: rows,
          levels: [...progress.values()].map(({ glossId, dimension, level }) => ({ glossId, dimension, level })),
          today: date,
          steps,
          done,
          newToday: introduced.size,
          listening: true,
          speaking: true,
          rng: () => 0.5,
          families: { familyOf: families.familyOf, waiting, newMeanings: families.newMeanings },
        };
        picks = chooseWords(input);
      }
      const path = target?.id ?? null;
      const readinessBefore = readinessNow();
      const entry: PathSession = { at, day, date, path, home, mode, picks, input, families, budget, readiness: { before: readinessBefore, after: readinessBefore } };
      sessions.push(entry);
      const planned = picks.map((pick, i) => ({
        form: `w${i}`,
        translation: `מ${i}`,
        tiles: true,
        speakable: true,
        clozeGap: true,
        dimension: pick.dimension,
        rung: pick.rung,
        level: pick.level,
        r: pick.r,
        step: pick.cls === 'STEP',
        knownMeanings: families ? families.introductions.get(pick.glossId) : meanings.get(pick.glossId),
        ladder: pick.ladder,
      }));
      const cardPlan = planCards(planned, { listening: true, speaking: true, target: target !== undefined });
      // Spec D2: the start asks for the path's next stock, built beside this session in flight.
      if (target && stockLag) {
        const inFlight = cardPlan.order.map((index, position) => ({
          glossId: picks[index].glossId,
          type: cardPlan.types[position],
          intro: cardPlan.intro[position],
        }));
        stocks.set(target.id, chooseFor(target, inFlight));
      }

      const given: AnsweredQuestion[] = cardPlan.order.map((index, position) => {
        const pick = picks[index];
        const type = cardPlan.types[position];
        const intro = cardPlan.intro[position];
        const free = UNMISSED.has(type) || intro;
        const rhythm = free || (cards++ % missEvery !== missEvery - 1 && !forgets.has(pick.glossId));
        const verdict: Verdict = (free ? undefined : scripted?.({ glossId: pick.glossId, type, date }, log)) ?? (rhythm ? 'right' : 'wrong');
        const { knownMeanings } = planned[index];
        log.push({ session, at, glossId: pick.glossId, cls: pick.cls, rung: pick.rung, type, right: verdict === 'right', knownMeanings, intro, path, verdict, date });
        return { ...pathAnswer(pick.glossId, type, verdict), intro };
      });

      const glossIds = [...new Set(given.map((answer) => answer.glossId))];
      const before = [...memory.values()].filter((row) => glossIds.includes(row.glossId));
      const timed = given.map((answer) => ({ ...answer, helped: false, answeredAt: `${date}T12:00:00.000000Z` }));
      // Phase 65 (spec D2, ruling R1): readiness from the main memory as it stood before this
      // session's own memory write, as recordProgress writes it.
      const read = readinessSessionWrite({
        sessionId: `s${at}`,
        day: date,
        targets: holding,
        before: [...readinessRows.values()],
        memory: before,
        answers: timed,
      });
      for (const row of read.rows) readinessRows.set(`${row.targetId}|${row.glossId}|${row.dimension}`, row);
      readinessEvents.push(...read.events);
      for (const row of applySession(before, given, date)) memory.set(keyOf(row.glossId, row.dimension), row);
      const levels = glossIds.flatMap((glossId) =>
        DIMENSIONS.map(
          (dimension) => progress.get(keyOf(glossId, dimension)) ?? { glossId, dimension, level: 1, lastStepOn: null, lastWrongOn: null },
        ),
      );
      for (const row of evaluateSession(levels, given, date).changed) progress.set(keyOf(row.glossId, row.dimension), row);
      // Spec D4: the target skills of every active target holding a word the session asked, whatever
      // its path, each against its own cap, as recordProgress writes them.
      // Phase 65b (spec D2): past the budget, the session moves its own target only for the owed
      // words its stock recorded, as recordProgress reads session_targets.past_budget.
      const planOnly = mode === 'past_budget' && path !== null ? { targetId: path, glossIds: owedRecorded } : undefined;
      const write = targetSessionWrite({ sessionId: `s${at}`, day: date, targets: holding, before: [...skills.values()], answers: timed, planOnly });
      for (const row of write.rows) skills.set(`${row.targetId}|${row.glossId}|${row.dimension}`, row);
      events.push(...write.events);
      for (const { targetId, glossIds: asked } of write.started) {
        for (const glossId of asked) if (!startedOn.has(`${targetId}|${glossId}`)) startedOn.set(`${targetId}|${glossId}`, date);
      }
      for (const glossId of glossIds) {
        if (!met.has(glossId)) {
          met.add(glossId);
          introduced.add(glossId);
        }
      }
      today.push(...given.map((answer) => ({ ...answer, sessionId: `s${at}` })));
      pathOf.set(`s${at}`, path);
      entry.readiness = { before: readinessBefore, after: readinessNow() };
      played++;
    }
    record.push({ date, played, memory: memoryAtStart, start, end: homeNow(), readiness: { start: readinessStart, end: readinessNow() } });
  }
  return { sessions, log, days: record, events, startedOn, budgets: budgetsSet, readinessEvents };
}

/** The run's day of `date`. */
const dayIndex = (date: string) => daysBetween(LANE0_DAY.today, date);

/** Spec §7, phase 53's measure: the share of the target's words ready by FSRS on its due date, by
 *  the memory the day before left: recall on the date in the weakest live skill at TARGET_READY. */
function fsrsReadyShare(run: PathRun, target: SimTarget): number {
  const due = run.days[dayIndex(target.dueOn)];
  const ready = target.words.filter(
    ({ glossId }) =>
      readinessOf(target.kind, recallOnDue(due.memory.filter((row) => row.glossId === glossId), LIVE, true, target.dueOn)) === 'ready',
  ).length;
  return ready / target.words.length;
}

/** The target's day on `date`, before its first session (`start`) or after its last (`end`). */
const targetOn = (run: PathRun, id: string, date: string, when: 'start' | 'end') => run.days[dayIndex(date)][when].get(id);

/** The days the learner practised the target: some session on its path. */
const practiceDaysOf = (run: PathRun, id: string) =>
  run.days.filter(({ date }) => run.sessions.some((session) => session.date === date && session.path === id)).map(({ date }) => date);

/**
 * Anti-goal 1 (spec D7 step 4, Done 7; phase 67 spec D2). While its target has work owed, a target's
 * session asks only cards that serve it: a card of an owed word owed a start (its ladder, or a known
 * word's first card), or one that asks a skill still open today while its cards are not all asked,
 * all as home read the target's day before the session. Returns the cards checked.
 */
function expectOnlyOwedWork(run: PathRun): number {
  let checked = 0;
  for (const session of run.sessions) {
    if (session.path === null) continue;
    // Phase 65b (spec D2): past the day's budget a session fills with practice more after its
    // owed work, the anti-goal's one exception; the picker's tests pin the owed work first.
    if (session.mode === 'past_budget') continue;
    const day = session.home.get(session.path)!;
    if (day.state !== 'owed') continue;
    const words = new Map(day.words.map((word) => [word.glossId, word]));
    for (const card of run.log.filter((asked) => asked.at === session.at)) {
      const word = words.get(card.glossId);
      // A card serves the word's day when it asks a skill still open today while cards are left: the
      // stock chosen beside a session in flight can take another open skill than home ranks first.
      const asked = servedSkill(card.type);
      const serves = word?.state === 'owed' && (word.toStart || (asked !== null && word.cardsLeft > 0 && word.open.includes(asked)));
      expect({ at: session.at, glossId: card.glossId, type: card.type, serves }).toEqual({
        at: session.at,
        glossId: card.glossId,
        type: card.type,
        serves: true,
      });
      checked++;
    }
  }
  return checked;
}

/** Phase 65 (spec D3.6, D11; anti-goal "readiness moves overnight"). Each active target's readiness
 *  at the start of a day reads as it did at the end of the day before, and so does every word it
 *  held then, while its date stays (a date moved is the list's edit, not a night): nothing moves it
 *  without an answer. A word added overnight joins at its own chance, so the list's percent is
 *  compared only when the words are the same. Returns the nights compared. */
function expectNothingOvernight(run: PathRun): number {
  let nights = 0;
  run.days.forEach((day, i) => {
    const next = run.days[i + 1];
    if (!next) return;
    for (const [id, end] of day.readiness.end) {
      const start = next.readiness.start.get(id);
      if (!start || start.dueOn !== end.dueOn) continue;
      nights++;
      const kept = [...end.words].filter(([glossId]) => start.words.has(glossId));
      const sameWords = kept.length === end.words.size && start.words.size === end.words.size;
      expect({
        date: next.date,
        id,
        words: kept.map(([glossId]) => [glossId, start.words.get(glossId)]),
        pct: sameWords ? start.pct : end.pct,
      }).toEqual({ date: next.date, id, words: kept, pct: end.pct });
    }
  });
  return nights;
}

/** The pieces a card graded, as the session end read its answer. */
const piecesOf = (card: PathAsked) => gradesFor({ ...pathAnswer(card.glossId, card.type, card.verdict), intro: card.intro });

/** Phase 65 (spec D3, D11; anti-goal "a right answer lowers it"). Across a session whose answers
 *  about a target's words, in the skills it counts, were all right, the target's readiness and each
 *  of its words' chances never drop. A session with a miss among them is exempt. Returns the
 *  (session, target) pairs checked: those with some such answer. */
function expectNoDropWhenRight(run: PathRun): number {
  let checked = 0;
  for (const session of run.sessions) {
    const cards = run.log.filter((card) => card.at === session.at);
    for (const [id, before] of session.readiness.before) {
      const counted = new Set(countedSkills(before.kind, LIVE));
      const pieces = cards.filter((card) => before.words.has(card.glossId)).flatMap((card) => piecesOf(card).filter((piece) => counted.has(piece.dimension)));
      if (pieces.length === 0 || pieces.some((piece) => piece.grade === 1)) continue;
      checked++;
      const after = session.readiness.after.get(id)!;
      const dropped = [...before.words].filter(([glossId, pct]) => after.words.get(glossId)! < pct).map(([glossId]) => glossId);
      expect({ at: session.at, id, dropped, pct: after.pct >= before.pct }).toEqual({ at: session.at, id, dropped: [], pct: true });
    }
  }
  return checked;
}

/** Phase 65 (spec D7.1, D11), ruling T5-c: the simulation's own fidelity, not the product's rule.
 *  Each target day its path played has one budget in this runner, set before the path's first
 *  session that day, and every session of the path that day read it as set, so the coverage the
 *  reports give is measured against the budget the service would have kept. The product's rule (a
 *  later start leaves the day's budget as it is; anti-goal "the count of today's sessions grows")
 *  is gated in tests/integration/services/sessions.targets.test.ts. Returns the target days
 *  checked. */
function expectBudgetSetOnce(run: PathRun): number {
  const days = new Map<string, PathSession[]>();
  for (const session of run.sessions.filter((one) => one.path !== null)) {
    const key = `${session.path}|${session.date}`;
    days.set(key, [...(days.get(key) ?? []), session]);
  }
  for (const [key, played] of days) {
    const set = run.budgets.filter((budget) => `${budget.targetId}|${budget.date}` === key);
    expect({ key, set: set.length, at: set[0]?.at, read: played.map((session) => session.budget) }).toEqual({
      key,
      set: 1,
      at: played[0].at,
      read: played.map(() => set[0]?.sessions),
    });
  }
  return days.size;
}

/** Phase 65 (spec D3.7): readiness on the date, as the eve left it. */
const readinessOnDate = (run: PathRun, target: SimTarget) => run.days[dayIndex(target.dueOn)].readiness.start.get(target.id)!.pct;

/**
 * Phase 65 (spec D11), reported, not gated: per run (each phase of the rhythm, where the scenario has
 * them), readiness on the date beside phase 53's share ready by FSRS, the yardstick for tuning; and
 * the target days whose sessions on its path fit the budget set before the first, with those that
 * did not, eve first (days left:sessions/budget).
 */
function itReportsTheDate(runs: readonly PathRun[], target: SimTarget) {
  const readiness = runs.map((run) => readinessOnDate(run, target)).join(' ');
  const shares = runs.map((run) => fsrsReadyShare(run, target).toFixed(2)).join(' ');
  const days = runs.flatMap((run) =>
    run.budgets
      .filter((budget) => budget.targetId === target.id)
      .map((budget) => ({ ...budget, played: run.sessions.filter((session) => session.date === budget.date && session.path === budget.targetId).length })),
  );
  const over = days
    .filter((day) => day.played > day.sessions)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .map((day) => `${day.daysLeft}:${day.played}/${day.sessions}`);
  const within = days.length - over.length;
  const share = days.length === 0 ? 0 : Math.round((100 * within) / days.length);
  it(`reports, ungated: readiness on the date ${readiness} beside the share ready by FSRS ${shares}; the day's sessions within its budget on ${within} of ${days.length} target days (${share}%), past it on ${over.join(' ') || 'none'} (days left:sessions/budget) (phase 65, spec D11)`, () => {
    expect(days.length).toBeGreaterThan(0);
  });
}

/** My words' sessions as phase 54's checks read a run: their inputs, picks and families, and their
 *  cards, numbered among them. */
function mainRun(run: PathRun): Run {
  const main = run.sessions.filter((session) => session.path === null);
  const index = new Map(main.map((session, k) => [session.at, k]));
  return {
    sessions: main.map((session) => ({ input: session.input!, picks: session.picks, families: session.families! })),
    log: run.log.filter((card) => index.has(card.at)).map((card) => ({ ...card, at: index.get(card.at)! })),
  };
}

/**
 * Spec D1, D4, D7, in every scenario: a target's session asks its own words only, each new one as a
 * ladder (phase 55's cards, in order), NEW_PER_SESSION ladders, SESSION_LENGTH graded cards and
 * TARGET_SPEAKING_PER_SESSION say translations at most, and only owed work while work is owed
 * (anti-goal 1); My words asks no word of an active target; no target value drops but by a miss
 * (anti-goal 2). `targets` are the run's targets as they stand on its last day.
 *
 * Phase 65 (spec D11): readiness never moves overnight and never drops across a session whose
 * answers about the target were all right, in `every` run of the scenario (each phase of the
 * rhythm, where it has them); and, the simulation's own fidelity check (ruling T5-c), its runner
 * sets the day's budget once.
 */
function itKeepsTheTargetPaths(run: PathRun, targets: readonly SimTarget[], every: readonly PathRun[] = [run]) {
  it(`never moves readiness overnight: a day starts where the day before ended, word by word, while the date stays, in ${every.length} run(s) (phase 65, spec D3.6, D11)`, () => {
    for (const one of every) expect(expectNothingOvernight(one)).toBeGreaterThan(0);
  });

  it(`never lowers readiness across a session whose answers about the target, in the skills it counts, were all right, in ${every.length} run(s) (phase 65, spec D3, D11)`, () => {
    // A run whose learner misses a word in nearly every session (phase 60's, forgetting the new
    // meaning) has almost none to check: the scenario's runs together must have some.
    expect(every.reduce((checked, one) => checked + expectNoDropWhenRight(one), 0)).toBeGreaterThan(0);
  });

  it(`simulation fidelity (ruling T5-c): the runner sets each target day's budget once, before its path's first session, and every session that day reads it, in ${every.length} run(s); the product's rule is gated in the integration tests (phase 65, spec D7.1, D11)`, () => {
    for (const one of every) expect(expectBudgetSetOnce(one)).toBeGreaterThan(0);
  });

  it("asks a target's own words on its path, and none of an active target's on My words", () => {
    for (const session of run.sessions) {
      const active = targets.filter((target) => target.createdOn <= session.date && session.date <= target.dueOn);
      const own = session.path === null ? null : new Set(targets.find((target) => target.id === session.path)!.words.map((word) => word.glossId));
      const held = new Set(active.flatMap((target) => target.words.filter((word) => word.addedOn <= session.date).map((word) => word.glossId)));
      const strays = session.picks.filter((pick) => (own ? !own.has(pick.glossId) : held.has(pick.glossId))).map((pick) => pick.glossId);
      expect({ at: session.at, strays }).toEqual({ at: session.at, strays: [] });
    }
    expect(run.sessions.some((session) => session.path !== null)).toBe(true);
  });

  it('asks each new word of a target as a ladder, another word two cards at most, and two ladders and ten graded cards a session at most, with no speaking limit (spec D7, phase 67 D6)', () => {
    let ladders = 0;
    for (const session of run.sessions.filter((one) => one.path !== null)) {
      const cards = run.log.filter((card) => card.at === session.at);
      const ladderIds = new Set(session.picks.filter((pick) => pick.ladder).map((pick) => pick.glossId));
      // Spec D7: a ladder is its word's only pick; another word takes a card a pick, two at most.
      for (const glossId of new Set(session.picks.map((pick) => pick.glossId))) {
        const own = session.picks.filter((pick) => pick.glossId === glossId).length;
        const asked = cards.filter((card) => card.glossId === glossId);
        const types = asked.map((card) => card.type);
        expect({
          at: session.at,
          glossId,
          asked: ladderIds.has(glossId)
            ? { own, types }
            : { own: own <= 2, cards: types.length, intro: asked.some((card) => card.intro || card.type === 'meet') },
        }).toEqual({
          at: session.at,
          glossId,
          asked: ladderIds.has(glossId) ? { own: 1, types: LADDER } : { own: true, cards: own, intro: false },
        });
      }
      ladders += ladderIds.size;
      const graded = cards.filter((card) => !freeCard(card, ladderIds)).length;
      expect({ at: session.at, ladders: ladderIds.size <= NEW_PER_SESSION, graded: graded <= SESSION_LENGTH }).toEqual({
        at: session.at,
        ladders: true,
        graded: true,
      });
    }
    expect(ladders).toBeGreaterThan(0);
  });

  it('never asks a target card that serves no owed work while work is owed (anti-goal 1)', () => {
    expect(expectOnlyOwedWork(run)).toBeGreaterThan(0);
  });

  it('never lowers a target value but for a miss (anti-goal 2)', () => {
    expect(run.events.filter((event) => event.after < event.before && event.why !== 'miss')).toEqual([]);
    expect(run.events.length).toBeGreaterThan(0);
  });
}

/** Spec D1, D10: My words gets a target's words back the day after its date, not before, and keeps
 *  its speaking pick, phase 39's families and phase 54's ladders beside the target paths. */
function itKeepsMyWords(run: PathRun, targets: readonly SimTarget[]) {
  it('gives My words the words of a target back the day after its date, not before', () => {
    for (const target of targets) {
      for (const session of run.sessions.filter((one) => one.path === null)) {
        const main = new Set(session.input!.saved.map((gloss) => gloss.glossId));
        const back = target.words.filter((word) => word.addedOn <= session.date).every(({ glossId }) => main.has(glossId));
        expect({ at: session.at, target: target.id, back }).toEqual({ at: session.at, target: target.id, back: session.date > target.dueOn });
      }
      expect(run.sessions.some((session) => session.path === null && session.date > target.dueOn)).toBe(true);
    }
  });

  it("keeps My words' speaking pick to one a session, and phase 39's families", () => {
    const main = mainRun(run);
    main.sessions.forEach(({ picks }, at) => {
      expect({ at, speak: picks.filter((pick) => pick.cls === 'SPEAK').length <= SPEAKING_PER_SESSION }).toEqual({ at, speak: true });
    });
    expectOneGlossPerFamily(main.sessions);
    expectNoWaitingGloss(main.sessions);
  });

  itHoldsTheLadders(mainRun(run));
}

/** Both paths' rules, for a run that plays My words too. */
function itKeepsThePaths(run: PathRun, targets: readonly SimTarget[], every: readonly PathRun[] = [run]) {
  itKeepsTheTargetPaths(run, targets, every);
  itKeepsMyWords(run, targets);
}

describe.each<[TargetKind]>([['exam'], ['homework']])(
  "a target on its own path, phase 37's learner: %s due in 14 days, twenty words, six sessions a day (phase 57, spec §7)",
  (kind) => {
    const target = targetOf(kind, 14, listIds(1, 20));
    const runs = EVERY_PHASE.map((learner) => runPaths(withList(20), 16, SESSIONS_A_DAY, [target], learner));
    const [run] = runs;
    const shares = runs.map((one) => fsrsReadyShare(one, target));
    const share = mean(shares);
    const evenings = runs.map((one) => practiceDaysOf(one, kind).length);
    /** My words' sessions before the date, of the 84 the learner plays. */
    const mine = runs.map((one) => one.sessions.filter((session) => session.path === null && session.date < target.dueOn).length);

    const each = shares.map((one) => one.toFixed(2)).join(' ');
    it(`ready by FSRS on the due date, the mean over the rhythm's five phases: ${share.toFixed(2)} (${each}; pass ≥ ${READY_ON_DUE_PASS[kind].toFixed(2)})`, () => {
      expect(share).toBeGreaterThanOrEqual(READY_ON_DUE_PASS[kind]);
    });

    it(`reports, ungated, over the five phases: practice evenings (${evenings.join(' ')}) and My words' sessions before the date (${mine.join(' ')})`, () => {
      expect(evenings.every((count) => count > 0)).toBe(true);
    });

    it('never asks a target card that serves no owed work while work is owed, at any phase (anti-goal 1)', () => {
      for (const one of runs) expect(expectOnlyOwedWork(one)).toBeGreaterThan(0);
    });

    // Final review C1. The same learner, each target session the stock its previous one chose at
    // its start (spec D2's stock lag, as the service plays it). The marks above are measured as
    // before, one session after another; this run checks anti-goal 1 under the lag, and reports
    // what FSRS ready-on-due measures there, ungated (ruling F-C1-d).
    const lagged = EVERY_PHASE.map((learner) => runPaths(withList(20), 16, SESSIONS_A_DAY, [target], learner, { stockLag: true }));
    const laggedShares = lagged.map((one) => fsrsReadyShare(one, target).toFixed(2)).join(' ');
    it(`with the stock lag, never asks a target card that serves no owed work while work is owed, at any phase (anti-goal 1; FSRS ready-on-due measures ${laggedShares})`, () => {
      for (const one of lagged) expect(expectOnlyOwedWork(one)).toBeGreaterThan(0);
    });

    itReportsTheDate(runs, target);
    itKeepsThePaths(run, [target], [...runs, ...lagged]);
  },
);

/** Lane 0's homework of 2026-10-16 (the one-pager's evidence): six words, due the next day. */
const REPLAY = ['biglietto', 'spesa', 'stazione', 'divertirsi', 'chiave', 'cassetto'] as const;
const REPLAY_LIST: DayList = { ...withList(0), saved: [...LANE0_DAY.saved, ...REPLAY.map((glossId, i) => listWord(i + 1, 0, glossId))] };
/** The cards answered by typing the word, whose spelling a near miss grades Again. */
const TYPED_ANSWER: ReadonlySet<QuestionType> = new Set(['typed_translation', 'cloze_typed', 'sentence_translation']);
const NEAR_MISSES: ReadonlySet<string> = new Set(['spesa', 'cassetto']);
const GIVES_UP = 'divertirsi';

/** Spec Done 7, ruling P3. The learner of 2026-10-16: a spelling near miss in the first typed answer
 *  of spesa ("spessa") and cassetto ("casseto"), and a give-up on divertirsi's first two say
 *  translations; every other card right. */
const REPLAY_LEARNER: PathLearner = {
  missEvery: NEVER_MISSES,
  scripted: ({ glossId, type }, earlier) => {
    const before = earlier.filter((card) => card.glossId === glossId && !card.intro);
    if (NEAR_MISSES.has(glossId) && TYPED_ANSWER.has(type) && !before.some((card) => TYPED_ANSWER.has(card.type))) return 'near_miss';
    if (glossId === GIVES_UP && type === 'say_translation' && before.filter((card) => card.type === 'say_translation').length < 2) return 'gave_up';
    return undefined;
  },
};

describe('the 2026-10-16 replay: homework due tomorrow, six words, the same misses, played until done (phase 57, spec Done 7, ruling P3)', () => {
  const homework = targetOf('homework', 1, REPLAY);
  // Spec D2, final review C1: each session the stock its previous one chose at its start. Phase 65:
  // and the due date, which plays no session (no target owes work), for the date's report.
  const run = runPaths(REPLAY_LIST, 2, { untilDone: 25 }, [homework], REPLAY_LEARNER, { stockLag: true });
  const end = targetOn(run, 'homework', dueIn(0), 'end')!;
  const { played } = run.days[0];

  it(`gets the six words' day done the same evening, in ${played} sessions, its budget (phase 67, spec D2, D5)`, () => {
    expect(end.state).toBe('done');
    expect(played).toBe(run.budgets[0].sessions);
  });

  it('asks only cards that serve owed work: every card of every session (anti-goal 1)', () => {
    expect(expectOnlyOwedWork(run)).toBe(run.log.length);
  });

  it("misses as on 2026-10-16, and adds no card for a miss: each word is asked each counted skill once on its eve (phase 67, spec D2)", () => {
    const missed = run.log.filter((card) => card.verdict !== 'right');
    expect(missed.map(({ glossId, verdict }) => `${glossId} ${verdict}`).sort()).toEqual(['cassetto near_miss', 'divertirsi gave_up', 'spesa near_miss']);
    for (const glossId of REPLAY) {
      const served = run.log.filter((card) => card.glossId === glossId && card.date === dueIn(0) && !card.intro).map((card) => servedSkill(card.type));
      const asked = new Set(served.filter((skill) => skill !== null));
      expect({ glossId, asked: [...asked].sort() }).toEqual({ glossId, asked: ['spelling', 'spoken_productive', 'written_productive'] });
    }
  });

  itReportsTheDate([run], homework);
  itKeepsTheTargetPaths(run, [homework]);
});

describe("an exam in 3 days, ten words, phase 37's learner practising until each day is done (phase 57, spec Done 6)", () => {
  const exam = targetOf('exam', 3, listIds(1, 10));
  // Spec D2, final review C1: each target session the stock its previous one chose at its start.
  const runs = EVERY_PHASE.map((learner) => runPaths(withList(10), 4, { untilDone: 25 }, [exam], learner, { stockLag: true }));
  const [run] = runs;
  /** Per phase, each practice day's sessions and readiness at its end. */
  const days = runs.map((one) => one.days.slice(0, 3).map(({ played, readiness }) => `${played}:${readiness.end.get('exam')!.pct}%`).join(' '));

  it(`gets each day done in its budget (sessions:readiness at day end, days left 3 2 1, five phases: ${days.join(', ')}) (phase 67, spec D5)`, () => {
    for (const one of runs) {
      const ends = one.days.slice(0, 3).map(({ end }) => end.get('exam')!);
      expect(ends.map((day) => day.state)).toEqual(['done', 'done', 'done']);
      for (const budget of one.budgets) {
        expect({ date: budget.date, played: one.days[dayIndex(budget.date)].played }).toEqual({ date: budget.date, played: budget.sessions });
      }
    }
  });

  it('never asks a target card that serves no owed work while work is owed, at any phase (anti-goal 1)', () => {
    for (const one of runs) expect(expectOnlyOwedWork(one)).toBeGreaterThan(0);
  });

  itReportsTheDate(runs, exam);
  itKeepsTheTargetPaths(run, [exam], runs);
});

/** Phase 60 (spec D1, "targets too"). Two meanings of one word saved on the lists' first day: the
 *  first known (every live skill well past KNOWN_STABILITY), the second never asked. */
const MEANINGS = ['meaning-0', 'meaning-1'] as const;
const MEANINGS_LIST: DayList = {
  ...withList(4),
  saved: [
    ...withList(4).saved,
    ...MEANINGS.map((glossId, i) => ({ ...listWord(90 + i, 0, glossId), lexemeId: 'x-meaning', lemma: 'x-meaning', forms: ['f-meaning'], order: [0, i] as const })),
  ],
  memory: [
    ...withList(4).memory,
    ...LIVE.map((dimension) => ({
      glossId: MEANINGS[0],
      dimension,
      state: { stability: 30, difficulty: 5, lastDay: dayAfter(LANE0_DAY.today, -1), reps: 4, lapses: 0, params: 'fsrs6-default' },
    })),
  ],
};

describe("a known word's new meaning in homework due in 3 days, phase 37's learner practising until each day is done (phase 60, spec D1, on a target path)", () => {
  const homework = targetOf('homework', 3, [...listIds(1, 4), MEANINGS[1]]);
  const play = (learner: PathLearner) => runPaths(MEANINGS_LIST, 4, { untilDone: 25 }, [homework], learner, { stockLag: true });
  const runs = EVERY_PHASE.map((learner) => play(learner));
  // The new meaning always missed, at each place of the rhythm: a miss leaves it unlearned.
  const missed = EVERY_PHASE.map((learner) => play({ ...learner, forgets: new Set([MEANINGS[1]]) }));

  it('starts the new meaning on its path with one new_meaning card listing the known one, whichever card of five the learner misses', () => {
    runs.forEach((run, phase) => {
      const first = run.log.find((card) => card.glossId === MEANINGS[1]);
      expect({ phase, ...first }).toMatchObject({ phase, type: 'new_meaning', knownMeanings: ['list-90'], path: 'homework' });
    });
  });

  it('never meets the new meaning, nor gives it an intro stage, though the learner misses every card of it', () => {
    for (const run of [...runs, ...missed]) {
      const asked = run.log.filter((card) => card.glossId === MEANINGS[1]);
      expect(asked.filter((card) => card.type === 'meet' || card.intro)).toEqual([]);
    }
    // The check can fire: the missed new meaning is asked again after its new_meaning card.
    for (const run of missed) expect(run.log.filter((card) => card.glossId === MEANINGS[1]).length).toBeGreaterThan(1);
  });

  itReportsTheDate(runs, homework);
  itKeepsTheTargetPaths(runs[0], [homework], [...runs, ...missed]);
});

describe('an exam in 20 days, twenty words, a learner who never misses practising until each day is done (phase 57, spec Done 6, D5, D6)', () => {
  const exam = targetOf('exam', 20, listIds(1, 20));
  const learner: Learner = { missEvery: NEVER_MISSES };
  const run = runPaths(withList(20), 21, { untilDone: 25 }, [exam], learner, { stockLag: true });
  const evenings = practiceDaysOf(run, 'exam');
  const summary = evenings.map((date) => `${daysBetween(date, exam.dueOn)}:${run.days[dayIndex(date)].played}`).join(' ');

  it(`reports, ungated, ${evenings.length} evenings of practice in twenty days, each done that evening (days left:sessions ${summary}) (phase 67: long targets are not tuned)`, () => {
    for (const date of evenings) expect({ date, state: targetOn(run, 'exam', date, 'end')!.state }).toEqual({ date, state: 'done' });
  });

  it('has every word ready on its date', () => {
    expect(readinessOnDate(run, exam)).toBeGreaterThanOrEqual(90);
  });

  // Phase 67 (spec D2): each day's cards are that day's; a skipped day's words, still below 90, are
  // owed the next day, which gets them done. Day 2 meets new words, so it owes work.
  const skipped = 2;
  const skipping = runPaths(withList(20), 21, (day) => (day === skipped ? 0 : { untilDone: 25 }), [exam], learner, { stockLag: true });

  it('owes the words of a skipped day the next day, and gets them done then', () => {
    expect({ played: skipping.days[skipped].played, owed: targetOn(skipping, 'exam', dueIn(skipped), 'start')!.state }).toEqual({ played: 0, owed: 'owed' });
    expect(targetOn(skipping, 'exam', dueIn(skipped + 1), 'start')!.state).toBe('owed');
    expect(targetOn(skipping, 'exam', dueIn(skipped + 1), 'end')!.state).toBe('done');
    expect(readinessOnDate(skipping, exam)).toBeGreaterThanOrEqual(90);
  });

  itReportsTheDate([run], exam);
  itKeepsTheTargetPaths(run, [exam], [run, skipping]);
});

describe("words added after halfway, phase 37's learner: an exam due in 14 days, twenty words, four more added with 4 days left (phase 57, spec D6)", () => {
  const added = listIds(21, 24);
  const first = targetOf('exam', 14, listIds(1, 20));
  const exam: SimTarget = { ...first, words: [...first.words, ...added.map((glossId) => ({ glossId, addedOn: dueIn(10) }))] };
  const run = runPaths(withList(20, { words: 4, on: 10 }), 16, SESSIONS_A_DAY, [exam]);

  it('owes them at once and starts them the same day', () => {
    expect(targetOn(run, 'exam', dueIn(9), 'start')!.words).toHaveLength(20);
    const day = targetOn(run, 'exam', dueIn(10), 'start')!;
    for (const glossId of added) {
      expect({ glossId, ...day.words.find((word) => word.glossId === glossId), startedOn: run.startedOn.get(`exam|${glossId}`) }).toMatchObject({
        glossId,
        state: 'owed',
        toStart: true,
        startedOn: dueIn(10),
      });
    }
  });

  itReportsTheDate([run], exam);
  itKeepsThePaths(run, [exam]);
});

describe("a date moved earlier, phase 37's learner: an exam of twenty words due in 14 days, moved on day 3 to day 7 (phase 57, spec D5, D6)", () => {
  const examOn = (day: number): SimTarget[] => [targetOf('exam', day < 3 ? 14 : 7, listIds(1, 20))];
  const run = runPaths(withList(20), 9, SESSIONS_A_DAY, examOn);

  it('follows the new date from the day it moves: days left, the cap, and the words to meet, past the new halfway point 8 a day (phase 67, spec D3)', () => {
    const before = targetOn(run, 'exam', dueIn(2), 'start')!;
    expect({ daysLeft: before.daysLeft, capHalves: before.capHalves, toStart: before.words.filter((word) => word.toStart).length }).toEqual({
      daysLeft: 12,
      capHalves: capHalves(12),
      toStart: 3,
    });
    const moved = targetOn(run, 'exam', dueIn(3), 'start')!;
    expect({ daysLeft: moved.daysLeft, capHalves: moved.capHalves, state: moved.state, toStart: moved.words.filter((word) => word.toStart).length }).toEqual({
      daysLeft: 4,
      capHalves: capHalves(4),
      state: 'owed',
      toStart: 8,
    });
  });

  it('meets every word by its new eve, at most 8 a day', () => {
    const starts = listIds(1, 20).map((glossId) => run.startedOn.get(`exam|${glossId}`)!);
    expect(starts.filter((day) => !(day <= dueIn(6)))).toEqual([]);
    for (let day = 0; day < 6; day++) expect({ day, met: starts.filter((one) => one === dueIn(day)).length <= 8 }).toEqual({ day, met: true });
  });

  it('ends after the new date: no session on its path from the day after', () => {
    expect(run.sessions.filter((session) => session.date > dueIn(7) && session.path !== null)).toEqual([]);
    expect(targetOn(run, 'exam', dueIn(7), 'start')!.state).toBe('due_today');
  });

  itReportsTheDate([run], examOn(8)[0]);
  itKeepsThePaths(run, examOn(8));
});

/** Phase 65 (spec anti-goals, D3.4). The exam's words whose written productive the learner misses
 *  cold. */
const COLD: readonly string[] = ['t01', 't02'];

describe("the anti-goal: an exam in 5 days, ten words, the same two skills missed cold on every day they are asked, practising until each day is done (phase 65, spec anti-goals, D3.4; phase 67)", () => {
  const exam = targetOf('exam', 5, listIds(1, 10));
  /** The last two days before the date: days left 2 and 1. */
  const lastTwo = [dueIn(3), dueIn(4)];
  const asksWriting = (type: QuestionType) => dimensionsTested(type).includes('written_productive');
  /** Right on every card but, each day, the first that asks a cold word's written productive: the
   *  day's first try of that skill. Phase 67: a word ready before its last two days is asked no
   *  writing card then, so the cold words miss it every day, which keeps them below 90 and asked. */
  const learner: PathLearner = {
    missEvery: NEVER_MISSES,
    scripted: ({ glossId, type, date }, earlier) => {
      if (!COLD.includes(glossId) || !asksWriting(type)) return undefined;
      const tried = earlier.some((card) => card.date === date && card.glossId === glossId && !card.intro && asksWriting(card.type));
      return tried ? undefined : 'wrong';
    },
  };
  // Spec D2, final review C1: each target session the stock its previous one chose at its start.
  const run = runPaths(withList(10), 6, { untilDone: 25 }, [exam], learner, { stockLag: true });
  const onDate = readinessOnDate(run, exam);

  it("misses only those, each the day's first try of a cold word's written productive, and on each of the last two days", () => {
    const missed = run.log.filter((card) => card.verdict !== 'right');
    for (const card of missed) expect({ glossId: card.glossId, writing: asksWriting(card.type) }).toEqual({ glossId: expect.stringMatching(/^t0[12]$/), writing: true });
    for (const date of lastTwo) {
      expect({ date, cold: COLD.filter((glossId) => missed.some((card) => card.date === date && card.glossId === glossId)) }).toEqual({ date, cold: [...COLD] });
    }
    const misses = run.readinessEvents.filter((event) => event.why === 'first_miss' || event.why === 'miss');
    expect(misses.every((event) => COLD.includes(event.glossId) && event.dimension === 'written_productive' && event.why === 'first_miss')).toBe(true);
  });

  it(`reads below 90 on its date: ${onDate} (spec anti-goals: "still reads 90 or more on its date")`, () => {
    expect(onDate).toBeLessThan(90);
  });

  itReportsTheDate([run], exam);
  itKeepsTheTargetPaths(run, [exam]);
});

/** Phase 67 (spec Done 2). Victor's homework of 2026-10-17, fifteen words, given 5, 2 and 1 days
 *  before its date; phase 37's learner, at each phase of its rhythm, playing each day's budget
 *  (the picker makes no session past it while the day owes work, and a miss adds no card). */
/** Phase 67 (spec Done 2, 3). Measured 2026-10-20 over the rhythm's five phases: the most sessions
 *  any phase played, and the means on the date of readiness and of the share ready by FSRS (5 days:
 *  21, 88, 0.87; 2 days: 12, 79, 0.60; 1 day: 10, 74, 0.45). Never raised for sessions, nor lowered
 *  for the date, to let a change pass. */
const HOMEWORK_PASS: Record<number, { sessions: number; readiness: number; fsrs: number }> = {
  5: { sessions: 21, readiness: 85, fsrs: 0.85 },
  2: { sessions: 12, readiness: 75, fsrs: 0.55 },
  1: { sessions: 10, readiness: 70, fsrs: 0.4 },
};

describe.each<[number]>([[5], [2], [1]])('a homework of fifteen words given %i day(s) ahead, two cards a day (phase 67, spec D2, D3, D5)', (days) => {
  const homework = targetOf('homework', days, listIds(1, 15));
  const pass = HOMEWORK_PASS[days];
  const runs = EVERY_PHASE.map((learner) => runPaths(withList(15), days + 1, { untilDone: 25 }, [homework], learner, { stockLag: true }));
  const perDay = runs.map((run) => run.days.slice(0, days).map(({ played }) => played));
  const totals = perDay.map((one) => one.reduce((sum, n) => sum + n, 0));
  const onDate = runs.map((run) => readinessOnDate(run, homework));
  const shares = runs.map((run) => fsrsReadyShare(run, homework));

  it(`measures each day's sessions (${perDay.map((one) => one.join('+')).join(', ')}), readiness on the date (${onDate.join(' ')}) and the share ready by FSRS (${shares.map((one) => one.toFixed(2)).join(' ')})`, () => {
    for (const run of runs) {
      for (const budget of run.budgets) {
        expect({ date: budget.date, played: run.days[dayIndex(budget.date)].played }).toEqual({ date: budget.date, played: budget.sessions });
      }
    }
  });

  it(`plays ${Math.max(...totals)} sessions at most in all (pass ≤ ${pass.sessions})`, () => {
    expect(Math.max(...totals)).toBeLessThanOrEqual(pass.sessions);
  });

  it(`reads ${mean(onDate).toFixed(1)} on its date and ${mean(shares).toFixed(2)} ready by FSRS, the means over the five phases (pass ≥ ${pass.readiness}, ${pass.fsrs.toFixed(2)})`, () => {
    expect(mean(onDate)).toBeGreaterThanOrEqual(pass.readiness);
    expect(mean(shares)).toBeGreaterThanOrEqual(pass.fsrs);
  });

  itReportsTheDate(runs, homework);
  itKeepsTheTargetPaths(runs[0], [homework], runs);
});

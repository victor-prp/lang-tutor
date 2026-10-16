import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH, type Dimension, type QuestionType } from '@lang-tutor/core/domain';

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
import { evaluateSession, type AnsweredQuestion, type ProgressRow } from './progress';
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
        families: { familyOf: families.familyOf, waiting, introductions: new Set(families.introductions.keys()) },
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
 *  (unlearned), not answered today, and no family's introduction. */
function isLadder(glossId: string, input: ChoiceInput): boolean {
  return (
    !input.done.has(glossId) &&
    !input.families.introductions.has(glossId) &&
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

  const known = runs.flatMap(({ knownIn }) => FREE.filter((glossId) => knownIn.has(glossId))).length;

  it(`gets the list's words known as often as phase 53 did, over the five phases: ${known} of ${FREE.length * runs.length} (pass ≥ ${KNOWN_ON_PHASE_53}) (phase 46)`, () => {
    // FREE is what waits on nothing when the run starts.
    expect(FAMILIES.saved.map(({ glossId }) => glossId).filter((glossId) => sessions[0].families.state.get(glossId) !== 'waiting')).toEqual(FREE);
    expect(known).toBeGreaterThanOrEqual(KNOWN_ON_PHASE_53);
  });
});

// Phase 53 (spec §2): the day simulation with targets. Phase 57 (spec §7): the phase 53 target
// scenarios read the split session (targetSession.ts, targetWish, splitSlots, owedNew), which phase
// 57 removed with paths (spec D1, §8); they are rewritten in Task 7 over the target picker, each
// target on a path of its own. Their marks stay the gates and are never lowered (spec §7): the
// share of a list ready by FSRS on its due date, exam 0.57 (the mean over the rhythm's five
// phases), homework 0.85.

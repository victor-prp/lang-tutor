import { describe, expect, it } from '@jest/globals';
import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

import { chooseWords, liveDimensions, type ChoiceInput, type ChosenPick } from './choose';
import { DAY_NEW_CAP, KNOWN_STABILITY, RETURNS_PER_DAY } from './chooseConstants';
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
 */

const DIMENSIONS: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];
const CHOICE: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'new_meaning', 'reverse_choice', 'listen_choice', 'matching', 'cloze_choice']);
const SPEAKING_CARDS: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);
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
 *  memory either way). */
function answerOf(glossId: string, type: QuestionType, right: boolean): AnsweredQuestion {
  if (CHOICE.has(type)) return { glossId, type, correct: right } as AnsweredQuestion;
  if (type === 'read_aloud') return { glossId, type, verdict: 'understood' };
  if (type === 'say_translation') return { glossId, type, verdict: right ? 'understood' : 'gave_up' };
  return { glossId, type, verdict: right ? 'exact' : 'wrong' } as AnsweredQuestion;
}

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}|${dimension}`;
const dayAfter = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** `days` days of `count` sessions over `list`, each session ended as recordProgress
 *  ends one. Memory, levels, the words met and known_at carry from day to day; the
 *  day's answers and the words it introduced start again each day. */
function runDays(
  list: DayList,
  days: number,
  count: number,
  missEvery = 5,
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
  let cards = 0;

  for (let day = 0; day < days; day++) {
    const date = dayAfter(list.today, day);
    const today: DayAnswer[] = [];
    const introduced = new Set<string>();
    introducedByDay.push(introduced);

    for (let session = 0; session < count; session++) {
      const at = sessions.length;
      const rows = [...memory.values()];
      const families = glossFamilies({
        saved: list.saved.map((gloss) => ({ ...gloss, knownAt: knownIn.has(gloss.glossId) ? `session ${knownIn.get(gloss.glossId)}` : null })),
        memory: rows,
        live: LIVE,
      });
      for (const glossId of families.newlyKnown) knownIn.set(glossId, at);
      const waiting = new Set([...families.state].filter(([, state]) => state === 'waiting').map(([glossId]) => glossId));

      const { steps, done } = dayState(today, introduced);
      const input: ChoiceInput = {
        saved: list.saved,
        memory: rows,
        levels: [...progress.values()].map(({ glossId, dimension, level }) => ({ glossId, dimension, level })),
        today: date,
        steps,
        done,
        newToday: introduced.size,
        listening: true,
        speaking: true,
        rng: () => 0.5,
        families: { familyOf: families.familyOf, waiting },
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
      }));
      const plan = planCards(planned, { listening: true, speaking: true });

      const given: AnsweredQuestion[] = plan.order.map((index, position) => {
        const pick = picks[index];
        const type = plan.types[position];
        const right = type === 'read_aloud' || cards++ % missEvery !== missEvery - 1;
        const { knownMeanings } = planned[index];
        log.push({ session, at, glossId: pick.glossId, cls: pick.cls, rung: pick.rung, type, right, knownMeanings });
        return answerOf(pick.glossId, type, right);
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

/** A list, its sessions, what the day should meet in new words, and whether it has
 *  gloss families (phase 39). */
const DAYS: [string, DayList, number, (met: number) => void, boolean][] = [
  ['lane 0, the nine sessions of 2026-10-11', LANE0_DAY, LANE0_DAY.sessions, (met) => expect(met).toBeGreaterThan(2), true],
  ['lane 0 over twenty sessions', LANE0_DAY, 20, (met) => expect(met).toBe(DAY_NEW_CAP), true],
  ['a new learner, thirty words saved and none met, over six sessions', FRESH, 6, (met) => expect(met).toBe(DAY_NEW_CAP), false],
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
    const met = log.filter((card) => card.cls === 'NEW' && card.session < last);
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
      // D1: a word comes back at most RETURNS_PER_DAY times a day. Returns are asked
      // last, and the last card of a ten-card session is always one this learner
      // misses, so some words use them all.
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
      // Every word the session could ask besides the done ones was asked.
      const others = chooseWords({ ...input, saved: input.saved.filter((gloss) => !input.done.has(gloss.glossId)), done: new Set() });
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

  it('meets new words up to the daily limit, and recalls', () => {
    checkMet(introduced.size);
    expect(log.some((card) => card.rung === 2 && RECALL.has(card.type))).toBe(true);
  });
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

/** Phase 39 (spec D2, D12). A learner who misses one card in ten. At six sessions a
 *  day the seven glosses not waiting are each asked in every session, so the phase 37
 *  learner, missing one card in five, misses each of them about once a day. A miss
 *  drops the skill it tests, even on a day the skill was already right, and a second
 *  right answer that day adds nothing: no gloss of this list is then ever known in all
 *  five skills (none in sixty days), and no second meaning ever comes. */
const MISS_EVERY = 10;

describe('families over days: ten days of six sessions (phase 39)', () => {
  const { log, sessions, knownIn } = runDays(FAMILIES, 10, 6, MISS_EVERY);

  it('6 and 7 have families to check, and a gloss that waits', () => {
    expect(familiesChecked(sessions)).toEqual({ families: true, waited: true });
  });

  it('6. never asks two glosses of one family in a session', () => {
    expectOneGlossPerFamily(sessions);
  });

  it('7. never asks a waiting gloss', () => {
    expectNoWaitingGloss(sessions);
  });

  it("asks a word's second meaning once its first is known, first as a new_meaning that lists the first", () => {
    const asked = log.filter((card) => FIVE.includes(card.glossId));
    // The most common meaning is the word's first (D3).
    expect(asked[0]?.glossId).toBe('m0');
    const second = asked.find((card) => card.glossId !== 'm0');
    expect(second).toBeDefined();
    expect(knownIn.has('m0')).toBe(true);
    expect(second!.at).toBeGreaterThanOrEqual(knownIn.get('m0')!);
    expect(second).toMatchObject({ glossId: 'm1', type: 'new_meaning', knownMeanings: ['five-0'] });
  });

  it('asks the other reading of a shared spelling the same way', () => {
    const second = log.find((card) => card.glossId === 'h1');
    expect(knownIn.has('h0')).toBe(true);
    expect(second?.at).toBeGreaterThanOrEqual(knownIn.get('h0')!);
    expect(second).toMatchObject({ type: 'new_meaning', knownMeanings: ['see'] });
  });
});

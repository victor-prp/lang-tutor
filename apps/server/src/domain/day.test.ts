import { describe, expect, it } from '@jest/globals';
import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

import { chooseWords, type ChoiceInput, type ChosenPick } from './choose';
import { DAY_NEW_CAP, RETURNS_PER_DAY } from './chooseConstants';
import { LANE0_DAY } from './day.fixture';
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
 */

const DIMENSIONS: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];
const CHOICE: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'reverse_choice', 'listen_choice', 'matching', 'cloze_choice']);
const SPEAKING_CARDS: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);
/** The recall types: rung 2 of some dimension (spec D6). */
const RECALL: ReadonlySet<QuestionType> = new Set(Object.values(RUNGS).flatMap(([, recall]) => recall));

type Asked = { session: number; glossId: string; cls: ChosenPick['cls']; rung: 1 | 2; type: QuestionType; right: boolean };
type Session = { input: ChoiceInput; picks: ChosenPick[] };
type DayList = {
  today: string;
  saved: ChoiceInput['saved'];
  memory: MemoryRow[];
  progress: ProgressRow[];
};

/** A new learner: thirty words saved this morning, none met. */
const FRESH: DayList = {
  today: '2026-10-12',
  saved: Array.from({ length: 30 }, (_, i) => ({
    glossId: `n${String(i).padStart(2, '0')}`,
    key: `fresh-${i}`,
    savedAt: `2026-10-12T08:${String(i).padStart(2, '0')}:00.000000Z`,
  })),
  memory: [],
  progress: [],
};

/** The fixed learner: every fifth card answered is wrong, and a read aloud is
 *  always understood (it writes no memory either way). */
function answerOf(glossId: string, type: QuestionType, right: boolean): AnsweredQuestion {
  if (CHOICE.has(type)) return { glossId, type, correct: right } as AnsweredQuestion;
  if (type === 'read_aloud') return { glossId, type, verdict: 'understood' };
  if (type === 'say_translation') return { glossId, type, verdict: right ? 'understood' : 'gave_up' };
  return { glossId, type, verdict: right ? 'exact' : 'wrong' } as AnsweredQuestion;
}

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}|${dimension}`;

/** One day of `count` sessions over `list`, each ended as recordProgress ends one. */
function runDay(list: DayList, count: number): { log: Asked[]; sessions: Session[]; introduced: Set<string> } {
  const memory = new Map<string, MemoryRow>(list.memory.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const progress = new Map<string, ProgressRow>(list.progress.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const met = new Set(list.memory.map((row) => row.glossId));
  const today: DayAnswer[] = [];
  const introduced = new Set<string>();
  const log: Asked[] = [];
  const sessions: Session[] = [];
  let cards = 0;

  for (let session = 0; session < count; session++) {
    const { steps, done } = dayState(today, introduced);
    const input: ChoiceInput = {
      saved: list.saved,
      memory: [...memory.values()],
      levels: [...progress.values()].map(({ glossId, dimension, level }) => ({ glossId, dimension, level })),
      today: list.today,
      steps,
      done,
      newToday: introduced.size,
      listening: true,
      speaking: true,
      rng: () => 0.5,
      families: { familyOf: new Map(), waiting: new Set() },
    };
    const picks = chooseWords(input);
    sessions.push({ input, picks });
    const plan = planCards(
      picks.map((pick, i) => ({
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
      })),
      { listening: true, speaking: true },
    );

    const given: AnsweredQuestion[] = plan.order.map((index, position) => {
      const pick = picks[index];
      const type = plan.types[position];
      const right = type === 'read_aloud' || cards++ % 5 !== 4;
      log.push({ session, glossId: pick.glossId, cls: pick.cls, rung: pick.rung, type, right });
      return answerOf(pick.glossId, type, right);
    });

    const glossIds = [...new Set(given.map((answer) => answer.glossId))];
    const before = [...memory.values()].filter((row) => glossIds.includes(row.glossId));
    for (const row of applySession(before, given, list.today)) memory.set(keyOf(row.glossId, row.dimension), row);
    const rows = glossIds.flatMap((glossId) =>
      DIMENSIONS.map(
        (dimension) => progress.get(keyOf(glossId, dimension)) ?? { glossId, dimension, level: 1, lastStepOn: null, lastWrongOn: null },
      ),
    );
    for (const row of evaluateSession(rows, given, list.today).changed) progress.set(keyOf(row.glossId, row.dimension), row);
    for (const glossId of glossIds) {
      if (!met.has(glossId)) {
        met.add(glossId);
        introduced.add(glossId);
      }
    }
    today.push(...given.map((answer) => ({ ...answer, sessionId: `s${session}` })));
  }
  return { log, sessions, introduced };
}

/** A list, its sessions, and what the day should meet in new words. */
const DAYS: [string, DayList, number, (met: number) => void][] = [
  ['lane 0, the nine sessions of 2026-10-11', LANE0_DAY, LANE0_DAY.sessions, (met) => expect(met).toBeGreaterThan(2)],
  ['lane 0 over twenty sessions', LANE0_DAY, 20, (met) => expect(met).toBe(DAY_NEW_CAP)],
  ['a new learner, thirty words saved and none met, over six sessions', FRESH, 6, (met) => expect(met).toBe(DAY_NEW_CAP)],
];

describe.each(DAYS)('a day: %s (phase 37)', (_name, list, count, checkMet) => {
  const { log, sessions, introduced } = runDay(list, count);
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

  it('meets new words up to the daily limit, and recalls', () => {
    checkMet(introduced.size);
    expect(log.some((card) => card.rung === 2 && RECALL.has(card.type))).toBe(true);
  });
});

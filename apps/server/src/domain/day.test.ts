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
 * The list is lane 0's at the start of 2026-10-11, when the learner did nine
 * sessions and met two new words; then the same list over twenty sessions.
 */

const DIMENSIONS: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling'];
const CHOICE: ReadonlySet<QuestionType> = new Set(['multiple_choice', 'reverse_choice', 'listen_choice', 'matching', 'cloze_choice']);
const SPEAKING_CARDS: ReadonlySet<QuestionType> = new Set(['read_aloud', 'say_translation']);
/** The recall types: rung 2 of some dimension (spec D6). */
const RECALL: ReadonlySet<QuestionType> = new Set(Object.values(RUNGS).flatMap(([, recall]) => recall));

type Asked = { session: number; glossId: string; cls: ChosenPick['cls']; rung: 1 | 2; type: QuestionType; right: boolean };
type Session = { input: ChoiceInput; picks: ChosenPick[] };

/** The fixed learner: every fifth card answered is wrong, and a read aloud is
 *  always understood (it writes no memory either way). */
function answerOf(glossId: string, type: QuestionType, right: boolean): AnsweredQuestion {
  if (CHOICE.has(type)) return { glossId, type, correct: right } as AnsweredQuestion;
  if (type === 'read_aloud') return { glossId, type, verdict: 'understood' };
  if (type === 'say_translation') return { glossId, type, verdict: right ? 'understood' : 'gave_up' };
  return { glossId, type, verdict: right ? 'exact' : 'wrong' } as AnsweredQuestion;
}

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}|${dimension}`;

/** One day of `count` sessions over the fixture, each ended as recordProgress ends one. */
function runDay(count: number): { log: Asked[]; sessions: Session[]; introduced: Set<string> } {
  const memory = new Map<string, MemoryRow>(LANE0_DAY.memory.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const progress = new Map<string, ProgressRow>(LANE0_DAY.progress.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const met = new Set(LANE0_DAY.memory.map((row) => row.glossId));
  const today: DayAnswer[] = [];
  const introduced = new Set<string>();
  const log: Asked[] = [];
  const sessions: Session[] = [];
  let cards = 0;

  for (let session = 0; session < count; session++) {
    const { steps, done } = dayState(today, introduced);
    const input: ChoiceInput = {
      saved: LANE0_DAY.saved,
      memory: [...memory.values()],
      levels: [...progress.values()].map(({ glossId, dimension, level }) => ({ glossId, dimension, level })),
      today: LANE0_DAY.today,
      steps,
      done,
      newToday: introduced.size,
      listening: true,
      speaking: true,
      rng: () => 0.5,
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
    for (const row of applySession(before, given, LANE0_DAY.today)) memory.set(keyOf(row.glossId, row.dimension), row);
    const rows = glossIds.flatMap((glossId) =>
      DIMENSIONS.map(
        (dimension) => progress.get(keyOf(glossId, dimension)) ?? { glossId, dimension, level: 1, lastStepOn: null, lastWrongOn: null },
      ),
    );
    for (const row of evaluateSession(rows, given, LANE0_DAY.today).changed) progress.set(keyOf(row.glossId, row.dimension), row);
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

describe.each([LANE0_DAY.sessions, 20])('a day of %i sessions on lane 0 list (phase 37)', (count) => {
  const { log, sessions, introduced } = runDay(count);
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
      // last and this learner misses every tenth card, so some words use them all.
      const returns = log.filter((earlier) => earlier.glossId === card.glossId && earlier.cls === 'STEP' && earlier.session <= card.session);
      if (returns.length >= RETURNS_PER_DAY) continue;
      const back = log.some((later) => later.glossId === card.glossId && later.session > card.session);
      expect({ glossId: card.glossId, session: card.session, back }).toEqual({ glossId: card.glossId, session: card.session, back: true });
    }
  });

  it('4. gives every session a speaking card while words not done today remain', () => {
    sessions.forEach(({ picks }, session) => {
      if (picks.some((pick) => pick.cls === 'DONE')) return;
      const spoke = log.some((card) => card.session === session && SPEAKING_CARDS.has(card.type));
      expect({ session, spoke }).toEqual({ session, spoke: true });
    });
  });

  it('5. asks a word done today only when no other word can be asked', () => {
    for (const { input, picks } of sessions) {
      if (!picks.some((pick) => pick.cls === 'DONE')) continue;
      const others = chooseWords({ ...input, saved: input.saved.filter((gloss) => !input.done.has(gloss.glossId)), done: new Set() });
      const asked = picks.filter((pick) => pick.cls !== 'DONE').map((pick) => pick.glossId);
      expect(asked.sort()).toEqual(others.map((pick) => pick.glossId).sort());
    }
  });

  if (count === LANE0_DAY.sessions) {
    it('meets more new words than the two that day did, and recalls some', () => {
      expect(introduced.size).toBeGreaterThan(2);
      expect(log.some((card) => card.rung === 2 && RECALL.has(card.type))).toBe(true);
    });
  } else {
    it('meets exactly the daily limit of new words', () => {
      expect(introduced.size).toBe(DAY_NEW_CAP);
    });
  }
});

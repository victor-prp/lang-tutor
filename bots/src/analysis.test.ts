import assert from 'node:assert/strict';
import { test } from 'node:test';

import { retrievability, review, type Dimension, type QuestionType } from '@lang-tutor/core/domain';
import type { AnswerVerdict } from '@lang-tutor/core/api';

import {
  WEAK_P,
  isLastDayOfWeek,
  liveDimensions,
  meanRecall,
  serverView,
  weekNumbers,
  weekOf,
} from './analysis.ts';
import type { BotMemory } from './memory.ts';
import { dateOf, newLine } from './play.ts';
import { newState, type BotState, type CardEntry, type DayLine } from './state.ts';

const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SP: Dimension = 'spelling';
const SR: Dimension = 'spoken_receptive';
const WRITTEN = [WR, WP, SP];

/** A handmade card: the session is the day's, unless given. */
function card(
  day: number,
  type: QuestionType,
  word: string | null,
  correct: boolean,
  recall: Partial<Record<Dimension, number>> = {},
  extra: { session?: string; verdict?: AnswerVerdict } = {},
): CardEntry {
  return {
    day,
    date: dateOf(day),
    hour: 8,
    session: extra.session ?? `s${day}`,
    card: `c${day}-${word}`,
    type,
    word,
    dimensions: [],
    recall,
    p: 0.5,
    outcome: correct ? 'right' : 'wrong',
    answer: 'x',
    ...(extra.verdict ? { verdict: extra.verdict } : {}),
    correct,
  };
}

function day(n: number, listPairs: number, listWeak: number): DayLine {
  return { ...newLine(n), played: true, completed: true, listPairs, listWeak };
}

function stateWith(log: CardEntry[], days: DayLine[] = [], saved: string[] = []): BotState {
  return {
    ...newState({ name: 'b', memory: 'actr' }),
    log,
    days,
    saved: saved.map((form) => ({ form, meaning: `m-${form}`, glossId: `g-${form}`, day: 1 })),
  };
}

const noMemory: BotMemory = { setTime() {}, recall: () => 0, learn() {} };

test('weeks: days 1 to 7 are week 1, and day 7 closes it', () => {
  assert.deepEqual([1, 7, 8, 14, 15].map(weekOf), [1, 1, 2, 2, 3]);
  assert.deepEqual([6, 7, 8, 14].map(isLastDayOfWeek), [false, true, false, true]);
});

test('live dimensions follow the devices, in the picker\'s order', () => {
  assert.deepEqual(liveDimensions({ listening: false, speaking: false }), WRITTEN);
  assert.deepEqual(liveDimensions({ listening: true, speaking: true }), [WR, WP, SR, SP, 'spoken_productive']);
});

test('(a) the weak cards\' share over the weak share of the list', () => {
  // Three of four cards on a word below 0.7 in the tested dimension (WR for multiple choice):
  // 0.75 of the cards. The list was half weak at its sessions: 5 of 10 pairs, then 5 of 10.
  const log = [
    card(1, 'multiple_choice', 'x', true, { [WR]: 0.2 }),
    card(1, 'multiple_choice', 'y', true, { [WR]: 0.5 }),
    card(2, 'multiple_choice', 'x', true, { [WR]: WEAK_P - 0.01 }),
    card(2, 'multiple_choice', 'y', true, { [WR]: 0.9 }),
    // Unmatched: no word, no truth to judge by.
    card(2, 'multiple_choice', null, false),
    // Week 2 does not count.
    card(8, 'multiple_choice', 'x', true, { [WR]: 0.9 }),
  ];
  const n = weekNumbers(stateWith(log, [day(1, 10, 5), day(2, 10, 5), day(8, 10, 1)]), 1, noMemory, WRITTEN);
  assert.equal(n.cards, 4);
  assert.equal(n.a, 0.75 / 0.5);
});

test('(a) is null with no card or no weak pair to compare with', () => {
  const none = weekNumbers(stateWith([], [day(1, 10, 5)]), 1, noMemory, WRITTEN);
  assert.equal(none.a, null);
  const strong = weekNumbers(stateWith([card(1, 'multiple_choice', 'x', true, { [WR]: 0.2 })], [day(1, 10, 0)]), 1, noMemory, WRITTEN);
  assert.equal(strong.a, null);
});

test('(b) for words 0.2 or more weaker in one dimension, the share of their cards testing it', () => {
  const log = [
    // x is weak in WP (0.5 against 0.95): a multiple choice tests WR, a miss.
    card(1, 'multiple_choice', 'x', true, { [WR]: 0.9, [WP]: 0.5, [SP]: 0.95 }),
    // A reverse choice tests WP: a hit.
    card(2, 'reverse_choice', 'x', true, { [WR]: 0.9, [WP]: 0.5, [SP]: 0.95 }),
    // y's dimensions are within 0.2 of each other: not counted.
    card(2, 'multiple_choice', 'y', true, { [WR]: 0.8, [WP]: 0.7, [SP]: 0.75 }),
  ];
  assert.equal(weekNumbers(stateWith(log), 1, noMemory, WRITTEN).b, 0.5);
});

test('(c) the median gap in days, for the 2nd, 3rd and 4th-or-later reviews right in a row', () => {
  const log = [
    card(1, 'multiple_choice', 'x', true),
    card(2, 'multiple_choice', 'x', true), // 2nd in a row, 1 day
    card(4, 'multiple_choice', 'x', true), // 3rd, 2 days
    card(1, 'multiple_choice', 'y', true),
    card(3, 'multiple_choice', 'y', true), // 2nd, 2 days
    card(6, 'multiple_choice', 'y', true), // 3rd, 3 days
    card(8, 'multiple_choice', 'x', true), // 4th, 4 days: week 2
    card(9, 'multiple_choice', 'x', false), // the run breaks
    card(10, 'multiple_choice', 'x', true), // 1st again
    card(13, 'multiple_choice', 'x', true), // 2nd, 3 days
    // Another dimension of x is its own run: a reverse choice tests WP.
    card(13, 'reverse_choice', 'x', true),
  ];
  const state = stateWith(log);
  assert.deepEqual(weekNumbers(state, 1, noMemory, WRITTEN).c, { second: 1.5, third: 2.5, later: null });
  assert.deepEqual(weekNumbers(state, 2, noMemory, WRITTEN).c, { second: 3, third: null, later: 4 });
});

test('(c) counts only the first review of a day: a same-day return is learning, not an interval', () => {
  const log = [
    card(1, 'multiple_choice', 'x', true, {}, { session: 's1' }),
    // Phase 37 (spec D8): met in s1, so owed a return later that day.
    card(1, 'typed_meaning', 'x', true, {}, { session: 's1b', verdict: 'exact' }),
    card(3, 'multiple_choice', 'x', true),
  ];
  assert.deepEqual(weekNumbers(stateWith(log), 1, noMemory, WRITTEN).c, { second: 2, third: null, later: null });
});

test('the server view replays memory and levels from the log, session by session', () => {
  const log = [
    card(1, 'multiple_choice', 'x', true),
    card(2, 'multiple_choice', 'x', true),
    card(3, 'multiple_choice', 'x', true, {}, { session: 's3' }),
    card(3, 'typed_meaning', 'x', true, {}, { session: 's3', verdict: 'exact' }),
  ];
  const view = serverView(log);
  // Day 1: no memory, level 1: recognition.
  assert.deepEqual(view[0], { dimension: WR, rung: 1, level: 1, r: null, implied: 1 });
  // Day 2: one Good review on day 1, level 2 after day 1's step. Memory at R above
  // RUNG_R implies recall whatever the level (phase 37 D2).
  const afterDay1 = review(null, 3, dateOf(1));
  assert.deepEqual(view[1], { dimension: WR, rung: 1, level: 2, r: retrievability(afterDay1, dateOf(2)), implied: 2 });
  // Day 3: level 3 a day after day 2's step, and R well above RUNG_R: recall is due.
  const afterDay2 = review(afterDay1, 3, dateOf(2));
  const r3 = retrievability(afterDay2, dateOf(3));
  assert.deepEqual(view[2], { dimension: WR, rung: 1, level: 3, r: r3, implied: 2 });
  // Same session: the server writes memory when the session ends, so the view has not moved.
  assert.deepEqual(view[3], { dimension: WR, rung: 2, level: 3, r: r3, implied: 2 });
});

test('a card that serves two dimensions is put on the one the picker would have chosen', () => {
  // x has fresh SR memory (R above R_TARGET, so not due) and none in SP: a dictation is SP being introduced
  // (rung 1), not SR at recall (rung 2).
  const log = [
    card(1, 'listen_choice', 'x', true),
    card(2, 'dictation', 'x', true, {}, { verdict: 'exact' }),
  ];
  assert.equal(serverView(log)[1]?.dimension, SP);
  assert.equal(serverView(log)[1]?.rung, 1);
  assert.equal(serverView([card(1, 'multiple_choice', null, true)])[0], null);
});

test('the server view puts a same-day return on its owed dimension, at recall', () => {
  // Phase 37 (spec D1, D8): met in s1 and missed, x is owed a written receptive return in a
  // later session that day; a dictation there would otherwise read as spelling at rung 1.
  const log = [
    card(1, 'multiple_choice', 'x', false, {}, { session: 's1' }),
    card(1, 'typed_meaning', 'x', true, {}, { session: 's1b', verdict: 'exact' }),
    card(1, 'listen_choice', 'y', false, {}, { session: 's1' }),
    card(1, 'dictation', 'y', true, {}, { session: 's1b', verdict: 'exact' }),
  ];
  const view = serverView(log);
  assert.deepEqual(view[1], { dimension: WR, rung: 2, level: 1, r: 1, implied: 2 });
  assert.deepEqual(view[3], { dimension: SR, rung: 2, level: 1, r: 1, implied: 2 });
});

test('(d) the share of cards whose rung is not the one memory implies (phase 37 D2)', () => {
  const log = [
    card(1, 'multiple_choice', 'x', true, {}, { session: 's1' }), // no memory: rung 1, implied 1
    card(1, 'typed_meaning', 'x', true, {}, { session: 's1b', verdict: 'exact' }), // a return: rung 2, implied 2
    card(2, 'typed_meaning', 'x', true, {}, { verdict: 'exact' }), // R above RUNG_R at level 2: rung 2, implied 2
    card(3, 'multiple_choice', 'x', true), // R above RUNG_R: rung 1, implied 2
  ];
  assert.equal(weekNumbers(stateWith(log), 1, noMemory, WRITTEN).d, 0.25);
});

test('(e) the mean true recall over every saved word and live dimension', () => {
  const recall: Record<string, number> = { 'x|written_receptive': 0.9, 'x|written_productive': 0.3, 'y|written_receptive': 0.6 };
  const memory: BotMemory = { setTime() {}, recall: (w, d) => recall[`${w}|${d}`] ?? 0, learn() {} };
  const saved = [
    { form: 'x', meaning: '', glossId: 'gx', day: 1 },
    { form: 'y', meaning: '', glossId: 'gy', day: 3 },
    // Saved after the week: not in it.
    { form: 'z', meaning: '', glossId: 'gz', day: 9 },
  ];
  assert.equal(meanRecall(memory, saved, [WR, WP], 7), (0.9 + 0.3 + 0.6 + 0) / 4);
  const state = { ...stateWith([]), saved };
  assert.equal(weekNumbers(state, 1, memory, [WR, WP]).e, (0.9 + 0.3 + 0.6 + 0) / 4);
  assert.equal(meanRecall(memory, [], [WR], 7), null);
});

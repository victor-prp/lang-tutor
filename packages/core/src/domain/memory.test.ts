import { describe, expect, it } from '@jest/globals';

import { FSRS6_DEFAULT, retrievability, review, type Grade, type MemoryState } from './memory';

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);

/** The review day at the interval FSRS gives for 90% retention: R(S, S) = 0.9, so S days, rounded.
 *  (The first whole day with R strictly below 0.9 is one day later: it is the same fixture, a day late.) */
function dueDay(state: MemoryState): string {
  return addDays(state.lastDay, Math.max(1, Math.round(state.stability)));
}

const START = '2026-01-01';

describe('review', () => {
  it('a first Good gives S = 2.3065', () => {
    const s = review(null, 3, START);
    expect(s.stability).toBeCloseTo(2.3065, 4);
    expect(s.reps).toBe(1);
    expect(s.lapses).toBe(0);
    expect(s.lastDay).toBe(START);
    expect(s.params).toBe(FSRS6_DEFAULT.id);
  });

  it('first Hard and Again start from w1 and w0', () => {
    expect(review(null, 2, START).stability).toBeCloseTo(1.2931, 4);
    expect(review(null, 1, START).stability).toBeCloseTo(0.212, 4);
  });

  it('Good on each due day gives intervals of 2, 11, 46 and 163 days, within a day', () => {
    let state = review(null, 3, START);
    const intervals: number[] = [];
    for (let i = 0; i < 4; i++) {
      const due = dueDay(state);
      intervals.push((Date.parse(due) - Date.parse(state.lastDay)) / DAY_MS);
      state = review(state, 3, due);
    }
    const expected = [2, 11, 46, 163];
    expected.forEach((e, i) => expect(Math.abs(intervals[i] - e)).toBeLessThanOrEqual(1));
  });

  it('Hard from S = 2.3065 at its due day gives about 7.5, and Again about 0.6', () => {
    const first = review(null, 3, START);
    const due = dueDay(first);
    // Whole days: t = 2 here, not the fractional 2.3065 the spec's 8.1 (Hard) and 11.9 (Good) were read at.
    expect(review(first, 2, due).stability).toBeCloseTo(7.5133, 3);
    expect(review(first, 3, due).stability).toBeCloseTo(10.9643, 3);
    expect(review(first, 1, due).stability).toBeCloseTo(0.6076, 3);
  });

  it('Again counts a lapse', () => {
    const first = review(null, 3, START);
    const after = review(first, 1, dueDay(first));
    expect(after.lapses).toBe(1);
    expect(after.reps).toBe(2);
  });

  it('a same-day Good never lowers S', () => {
    let state = review(null, 3, START);
    for (let i = 0; i < 5; i++) {
      const next = review(state, 3, START);
      expect(next.stability).toBeGreaterThanOrEqual(state.stability);
      state = next;
    }
    const hard = review(review(null, 3, START), 2, START);
    expect(hard.stability).toBeGreaterThanOrEqual(2.3065);
  });

  it('keeps D between 1 and 10', () => {
    let low: MemoryState = review(null, 3, START);
    let high: MemoryState = review(null, 1, START);
    for (let i = 0; i < 60; i++) {
      low = review(low, 3, addDays(low.lastDay, 1));
      high = review(high, 1, addDays(high.lastDay, 1));
      expect(low.difficulty).toBeGreaterThanOrEqual(1);
      expect(low.difficulty).toBeLessThanOrEqual(10);
      expect(high.difficulty).toBeGreaterThanOrEqual(1);
      expect(high.difficulty).toBeLessThanOrEqual(10);
    }
    expect(low.difficulty).toBeLessThan(high.difficulty);
    expect(high.difficulty).toBeGreaterThan(9.9);
  });

  it('retrievability is 1 on the day, 0.9 at S days, and falls with time', () => {
    const s = review(null, 3, START);
    expect(retrievability(s, START)).toBe(1);
    expect(retrievability(s, addDays(START, 2))).toBeLessThan(retrievability(s, addDays(START, 1)));
    const atS: MemoryState = { ...s, stability: 10 };
    expect(retrievability(atS, addDays(START, 10))).toBeCloseTo(0.9, 6);
  });

  it('does not mutate its input', () => {
    const s = review(null, 3, START);
    const copy = { ...s };
    review(s, 2, addDays(START, 3));
    expect(s).toEqual(copy);
    const grades: Grade[] = [1, 2, 3];
    expect(grades.length).toBe(3);
  });

  it('matches py-fsrs over a mixed sequence of whole days', () => {
    const steps: [string, Grade, number, number][] = [
      [addDays(START, 0), 3, 2.3065, 2.118104],
      [addDays(START, 2), 3, 10.964332, 2.111214],
      [addDays(START, 13), 1, 1.538337, 7.392238],
      [addDays(START, 13), 3, 1.571197, 7.380074],
      [addDays(START, 15), 2, 3.592268, 8.246],
      [addDays(START, 40), 3, 16.149692, 8.232982],
    ];
    let state: MemoryState | null = null;
    for (const [day, grade, s, d] of steps) {
      state = review(state, grade, day);
      expect(state.stability).toBeCloseTo(s, 4);
      expect(state.difficulty).toBeCloseTo(d, 4);
    }
    expect(state!.reps).toBe(6);
    expect(state!.lapses).toBe(1);
  });

  it('matches py-fsrs for a first Again and a first Hard', () => {
    const again = review(null, 1, START);
    expect(again.stability).toBeCloseTo(0.212, 4);
    expect(again.difficulty).toBeCloseTo(6.4133, 4);
    const hard = review(null, 2, START);
    expect(hard.stability).toBeCloseTo(1.2931, 4);
    expect(hard.difficulty).toBeCloseTo(5.112171, 4);
  });
});

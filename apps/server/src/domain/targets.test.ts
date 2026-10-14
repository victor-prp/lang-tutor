import { describe, expect, it } from '@jest/globals';
import { SESSION_LENGTH, retrievability, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import {
  owedNew,
  readinessOf,
  recallOnDue,
  splitSlots,
  targetWish,
  type Readiness,
  type SplitInput,
  type TargetKind,
} from './targets';

const DUE = '2026-10-20';
const REVIEWED = '2026-10-10';

/** A state last reviewed on lastDay. Reviewed 10 days before DUE, stability 10 gives R = 0.9 on DUE
 *  (R is 0.9 once the days since the review equal the stability: the model's definition), and a
 *  higher stability gives a higher R. */
function memory(stability: number, lastDay = REVIEWED): MemoryState {
  return { stability, difficulty: 5, lastDay, reps: 3, lapses: 0, params: 'fsrs6-default' };
}

const row = (dimension: Dimension, stability: number, lastDay = REVIEWED) => ({
  dimension,
  state: memory(stability, lastDay),
});

describe('recallOnDue', () => {
  it('is null for a gloss with no memory row: not met', () => {
    expect(recallOnDue([], ['written_receptive', 'spelling'], true, DUE)).toBeNull();
  });

  it('counts a live skill with no row as 0', () => {
    expect(recallOnDue([row('written_receptive', 30)], ['written_receptive', 'spelling'], true, DUE)).toBe(0);
  });

  it('is 1 when the date is on or before every last review', () => {
    const rows = [row('written_receptive', 5, DUE), row('spelling', 5, '2026-10-25')];
    expect(recallOnDue(rows, ['written_receptive', 'spelling'], true, DUE)).toBe(1);
  });

  it('takes the weakest live skill, whatever the order of the rows', () => {
    const rows = [row('written_receptive', 100), row('spelling', 10)];
    const live: Dimension[] = ['written_receptive', 'spelling'];
    const recall = recallOnDue(rows, live, true, DUE);
    expect(recall).toBeCloseTo(0.9, 10);
    expect(recall).toBe(retrievability(memory(10), DUE));
    expect(retrievability(memory(100), DUE)).toBeGreaterThan(0.9);
    expect(recallOnDue([...rows].reverse(), live, true, DUE)).toBe(recall);
  });

  it('reads only the live skills: a weak row in a skill that is off does not count', () => {
    const rows = [row('written_receptive', 30), row('spoken_receptive', 1)];
    expect(recallOnDue(rows, ['written_receptive'], true, DUE)).toBe(retrievability(memory(30), DUE));
  });

  it('is 0, not null, when the only rows are in skills that are off: the gloss was met', () => {
    expect(recallOnDue([row('spoken_receptive', 30)], ['written_receptive'], true, DUE)).toBe(0);
  });

  describe('spoken_productive', () => {
    const live: Dimension[] = ['written_receptive', 'spoken_productive'];

    it('is left out for a gloss that cannot be spoken: a skill it can never have does not hold it at 0', () => {
      expect(recallOnDue([row('written_receptive', 30)], live, false, DUE)).toBe(retrievability(memory(30), DUE));
    });

    it('counts for a gloss that can be spoken: 0 while it has no row', () => {
      expect(recallOnDue([row('written_receptive', 30)], live, true, DUE)).toBe(0);
    });

    it('counts its row only when the gloss can be spoken', () => {
      const rows = [row('written_receptive', 30), row('spoken_productive', 3)];
      expect(recallOnDue(rows, live, true, DUE)).toBe(retrievability(memory(3), DUE));
      expect(recallOnDue(rows, live, false, DUE)).toBe(retrievability(memory(30), DUE));
    });
  });
});

describe('readinessOf', () => {
  it.each<[TargetKind, number | null, Readiness]>([
    ['exam', 0.9, 'ready'],
    ['exam', 0.8999, 'almost'],
    ['exam', 0.7, 'almost'],
    ['exam', 0.6999, 'on_the_way'],
    ['exam', null, 'not_started'],
    ['homework', 0.8, 'ready'],
    ['homework', 0.7999, 'almost'],
    ['homework', 0.6, 'almost'],
    ['homework', 0.5999, 'on_the_way'],
    ['homework', null, 'not_started'],
  ])('reads %s at %s as %s', (kind, recall, readiness) => {
    expect(readinessOf(kind, recall)).toBe(readiness);
  });

  it('tells a word met and wholly forgotten from one not met', () => {
    expect(readinessOf('exam', 0)).toBe('on_the_way');
    expect(readinessOf('homework', 0)).toBe('on_the_way');
  });

  it('reads a sure thing as ready', () => {
    expect(readinessOf('exam', 1)).toBe('ready');
    expect(readinessOf('homework', 1)).toBe('ready');
  });
});

describe('targetWish', () => {
  it.each([
    // An exam's eve and run-up ask for the whole session, ready or not.
    { kind: 'exam', daysLeft: 1, ready: 0, words: 20, expected: { wish: 10, exclusive: true, reason: 'exclusive' } },
    { kind: 'exam', daysLeft: 1, ready: 20, words: 20, expected: { wish: 10, exclusive: true, reason: 'exclusive' } },
    { kind: 'exam', daysLeft: 2, ready: 20, words: 20, expected: { wish: 10, exclusive: false, reason: 'run_up' } },
    { kind: 'exam', daysLeft: 2, ready: 0, words: 20, expected: { wish: 10, exclusive: false, reason: 'run_up' } },
    // Before them the wish falls from 10 toward the steady 5 as the share of ready words rises.
    { kind: 'exam', daysLeft: 3, ready: 0, words: 20, expected: { wish: 10, exclusive: false, reason: 'not_ready' } },
    { kind: 'exam', daysLeft: 5, ready: 4, words: 20, expected: { wish: 9, exclusive: false, reason: 'not_ready' } },
    { kind: 'exam', daysLeft: 5, ready: 12, words: 20, expected: { wish: 7, exclusive: false, reason: 'not_ready' } },
    { kind: 'exam', daysLeft: 5, ready: 19, words: 20, expected: { wish: 6, exclusive: false, reason: 'not_ready' } },
    { kind: 'exam', daysLeft: 3, ready: 20, words: 20, expected: { wish: 5, exclusive: false, reason: 'steady' } },
    { kind: 'exam', daysLeft: 5, ready: 20, words: 20, expected: { wish: 5, exclusive: false, reason: 'steady' } },
    // A homework's from 10 toward the steady 3.
    { kind: 'homework', daysLeft: 5, ready: 0, words: 20, expected: { wish: 10, exclusive: false, reason: 'not_ready' } },
    { kind: 'homework', daysLeft: 5, ready: 15, words: 20, expected: { wish: 5, exclusive: false, reason: 'not_ready' } },
    { kind: 'homework', daysLeft: 2, ready: 20, words: 20, expected: { wish: 3, exclusive: false, reason: 'steady' } },
    { kind: 'homework', daysLeft: 5, ready: 20, words: 20, expected: { wish: 3, exclusive: false, reason: 'steady' } },
    // In integers: 3 + ceil(7 × 1 / 7) is 4, where 3 + ceil(7 × (1 − 6/7)) would read 5.
    { kind: 'homework', daysLeft: 5, ready: 6, words: 7, expected: { wish: 4, exclusive: false, reason: 'not_ready' } },
    // A homework's last day asks for at least 7: run_up while the graded wish is no higher.
    { kind: 'homework', daysLeft: 1, ready: 20, words: 20, expected: { wish: 7, exclusive: false, reason: 'run_up' } },
    { kind: 'homework', daysLeft: 1, ready: 10, words: 20, expected: { wish: 7, exclusive: false, reason: 'run_up' } },
    { kind: 'homework', daysLeft: 1, ready: 8, words: 20, expected: { wish: 8, exclusive: false, reason: 'not_ready' } },
    { kind: 'homework', daysLeft: 1, ready: 0, words: 20, expected: { wish: 10, exclusive: false, reason: 'not_ready' } },
    // A target with no words asks for its steady share; its pool picks nothing and passes it on.
    { kind: 'exam', daysLeft: 5, ready: 0, words: 0, expected: { wish: 5, exclusive: false, reason: 'steady' } },
    { kind: 'homework', daysLeft: 5, ready: 0, words: 0, expected: { wish: 3, exclusive: false, reason: 'steady' } },
  ] as const)('$kind at daysLeft $daysLeft, $ready of $words ready', ({ kind, daysLeft, ready, words, expected }) => {
    expect(targetWish(kind, daysLeft, ready, words)).toEqual(expected);
  });
});

describe('splitSlots', () => {
  const SOON = '2026-10-20';
  const LATER = '2026-10-25';
  const want = (targetId: string, dueOn: string, wish: number, exclusive = false): SplitInput => ({
    targetId,
    dueOn,
    wish,
    exclusive,
  });
  const split = (wishes: SplitInput[]) => Object.fromEntries(splitSlots(wishes, SESSION_LENGTH));

  it('grants every wish when together they fit in the session', () => {
    expect(split([want('a', SOON, 3), want('b', LATER, 5)])).toEqual({ a: 3, b: 5 });
  });

  it('splits evenly when two targets each want the whole session', () => {
    expect(split([want('a', SOON, 10), want('b', LATER, 10)])).toEqual({ a: 5, b: 5 });
  });

  it('shares in proportion to the wishes when they do not fit', () => {
    // Quotas 7.69 and 2.31: the odd slot goes to the larger remainder.
    expect(split([want('a', SOON, 10), want('b', LATER, 3)])).toEqual({ a: 8, b: 2 });
  });

  it('gives the odd slot to the larger remainder, not to the nearer date', () => {
    expect(split([want('a', LATER, 10), want('b', SOON, 3)])).toEqual({ a: 8, b: 2 });
  });

  it('breaks a tie in the remainders to the nearer date: three of 10 are 4, 3, 3', () => {
    const result = split([want('a', '2026-10-24', 10), want('b', '2026-10-22', 10), want('c', '2026-10-20', 10)]);
    expect(result).toEqual({ a: 3, b: 3, c: 4 });
  });

  it('breaks a tie on the date to the smaller target id', () => {
    const result = split([want('b', SOON, 10), want('c', SOON, 10), want('a', SOON, 10)]);
    expect(result).toEqual({ a: 4, b: 3, c: 3 });
  });

  it('ranks the remainders before the dates when several odd slots are left', () => {
    // Quotas 2.70, 2.70, 2.70 and 1.89: the farthest target has the largest remainder, so it
    // takes the first odd slot; the other two go to the nearer of the three equal ones.
    const result = split([
      want('a', '2026-10-21', 10),
      want('b', '2026-10-22', 10),
      want('c', '2026-10-23', 10),
      want('d', '2026-10-30', 7),
    ]);
    expect(result).toEqual({ a: 3, b: 3, c: 2, d: 2 });
  });

  it('gives an exclusive target the whole session and the rest nothing', () => {
    expect(split([want('a', SOON, 10, true), want('b', LATER, 3)])).toEqual({ a: 10, b: 0 });
  });

  it('lets exclusivity decide, not the wishes: the whole session even when the wishes would have fit', () => {
    expect(split([want('a', SOON, 4, true), want('b', LATER, 3)])).toEqual({ a: 10, b: 0 });
  });

  it('shares the session evenly between exclusive targets', () => {
    expect(split([want('a', SOON, 10, true), want('b', LATER, 10, true)])).toEqual({ a: 5, b: 5 });
  });

  it('breaks the tie in an uneven exclusive share to the nearer date', () => {
    const result = split([
      want('a', '2026-10-24', 10, true),
      want('b', '2026-10-22', 10, true),
      want('c', '2026-10-20', 10, true),
    ]);
    expect(result).toEqual({ a: 3, b: 3, c: 4 });
  });

  it('answers an empty list with an empty map', () => {
    expect(splitSlots([], SESSION_LENGTH).size).toBe(0);
  });

  it('never grants more than the session or than a target asked for, and uses the whole session when it must cut', () => {
    const asks = [1, 2, 3, 5, 7, 10];
    const wrong: string[] = [];
    for (const a of asks) {
      for (const b of asks) {
        for (const c of asks) {
          const result = split([want('a', '2026-10-21', a), want('b', '2026-10-22', b), want('c', '2026-10-23', c)]);
          const granted = Object.values(result);
          const asked = a + b + c;
          const cut = asked > SESSION_LENGTH;
          const sum = granted.reduce((n, slots) => n + slots, 0);
          // A cut share is within one slot of the exact proportion (floor or ceiling of it).
          const fair = [a, b, c].every((ask, i) =>
            cut ? Math.abs(granted[i] - (ask * SESSION_LENGTH) / asked) < 1 : granted[i] === ask,
          );
          if (sum !== Math.min(SESSION_LENGTH, asked) || !fair) wrong.push([a, b, c].join('/'));
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('owedNew', () => {
  it.each([
    // unmet, met today, days left, owed
    [20, 0, 14, 2], // 20 words over the 13 days before the last: 2 a day
    [20, 0, 2, 20], // tomorrow is the last day: all of them today
    [20, 0, 1, 20], // today is the last day: the days floor at 1, all of them at once
    [5, 3, 3, 1], // 8 words over 2 days is 4 a day, and 3 are met already
    [0, 0, 5, 0], // nothing unmet
    [10, 10, 4, 0], // ahead of the pace: 20 words over 3 days is 7 a day, and 10 are met already
  ])('unmet %i, met today %i, daysLeft %i: owes %i', (unmet, metToday, daysLeft, owed) => {
    expect(owedNew(unmet, metToday, daysLeft)).toBe(owed);
  });
});

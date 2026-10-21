import { describe, expect, it } from '@jest/globals';
import { FSRS6_DEFAULT, readinessFromMemory, type Dimension, type MemoryState, type ReadinessRow } from '@lang-tutor/core/domain';

import { canRaiseToday, pickNow, readinessSummary, skillStarts, todaySummary } from './targetSummary';

// Phase 65 (spec D1, D3.7, D4, D7, D9, D10). The numbers a target's summary carries: its
// readiness, where today started and its ready words; whether "practice more" asks first (phase
// 65b D1); and today as a budget of sessions. Pure: every row and count is passed in.

const TODAY = '2026-10-15';
const DUE = '2026-10-20';
const HOMEWORK_LIVE: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spelling', 'spoken_productive'];
/** A word the device cannot say: speaking is not live. */
const SILENT: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spelling'];

const state = (stability: number, lastDay: string): MemoryState => ({ stability, difficulty: 5, lastDay, reps: 3, lapses: 0, params: FSRS6_DEFAULT.id });
/** Exactly 0.9 on DUE: stability 5, last moved 5 days before. */
const AT_90 = state(5, TODAY);
/** About 0.967 on DUE. */
const AT_96 = state(20, TODAY);
/** About 0.846 on DUE. */
const AT_84 = state(10, '2026-09-30');
const row = (memory: MemoryState, over: Partial<ReadinessRow> = {}): ReadinessRow => ({ ...readinessFromMemory(memory), ...over });
const rowsOf = (glossId: string, dims: readonly Dimension[], r: ReadinessRow) => dims.map((dimension) => ({ glossId, dimension, row: r }));

const read = (over: Partial<Parameters<typeof readinessSummary>[0]> = {}) =>
  readinessSummary({ kind: 'homework', dueOn: DUE, today: TODAY, words: [], rows: [], memory: [], firstToday: [], ...over });

describe('readinessSummary (spec D1, D4)', () => {
  it("counts a homework word on write, spell and say, in the check's order, each from its row, as ready as its weakest (phase 67b D1)", () => {
    const summary = read({
      words: [{ glossId: 'g1', live: HOMEWORK_LIVE }],
      rows: [
        { glossId: 'g1', dimension: 'spoken_productive', row: row(AT_84) },
        { glossId: 'g1', dimension: 'written_productive', row: row(AT_96) },
        { glossId: 'g1', dimension: 'spelling', row: row(AT_96) },
        // Not counted: reading a word is not what the check asks.
        { glossId: 'g1', dimension: 'written_receptive', row: row(AT_84) },
      ],
    });
    expect(summary.words).toEqual([
      {
        glossId: 'g1',
        // The weakest, 0.846; the product would read 79.
        readinessPct: 84,
        // Its weakest, speaking, last moved on 30 Sep: open today.
        weakestOpenToday: true,
        skills: [
          { dimension: 'written_productive', chance: 96, held: false },
          { dimension: 'spelling', chance: 96, held: false },
          { dimension: 'spoken_productive', chance: 84, held: false },
        ],
      },
    ]);
    expect(summary.readinessPct).toBe(84);
  });

  it('drops speaking for a word that cannot be said: write and spell only, and not 0 (Review Focus 1)', () => {
    const summary = read({ words: [{ glossId: 'g1', live: SILENT }], rows: rowsOf('g1', ['written_productive', 'spelling'], row(AT_96)) });
    expect(summary.words[0].skills.map((skill) => skill.dimension)).toEqual(['written_productive', 'spelling']);
    // 96 is past the homework bar: the card counts it as 100 (phase 67b D2).
    expect(summary.words[0].readinessPct).toBe(100);
    expect(summary.readinessPct).toBe(100);
  });

  it('counts an exam on write and spell only', () => {
    const summary = read({ kind: 'exam', words: [{ glossId: 'g1', live: HOMEWORK_LIVE }], rows: rowsOf('g1', HOMEWORK_LIVE, row(AT_96)) });
    expect(summary.words[0].skills.map((skill) => skill.dimension)).toEqual(['written_productive', 'spelling']);
  });

  it('reads a skill with no row from the main memory (R1), and one with neither as 0', () => {
    const summary = read({
      words: [{ glossId: 'g1', live: SILENT }],
      rows: [{ glossId: 'g1', dimension: 'written_productive', row: row(AT_96) }],
      memory: [
        { glossId: 'g1', dimension: 'spelling', state: AT_90 },
        { glossId: 'g2', dimension: 'spelling', state: AT_96 },
      ],
    });
    expect(summary.words[0].skills).toEqual([
      { dimension: 'written_productive', chance: 96, held: false },
      { dimension: 'spelling', chance: 90, held: false },
    ]);
    const none = read({ words: [{ glossId: 'g1', live: SILENT }], rows: [{ glossId: 'g1', dimension: 'written_productive', row: row(AT_96) }] });
    expect(none.words[0]).toMatchObject({ readinessPct: 0, skills: [{ chance: 96 }, { dimension: 'spelling', chance: 0, held: false }] });
  });

  it('halves a held exam skill and says it is held', () => {
    const summary = read({
      kind: 'exam',
      words: [{ glossId: 'g1', live: SILENT }],
      rows: [
        { glossId: 'g1', dimension: 'written_productive', row: row(state(1e6, TODAY), { held: true }) },
        { glossId: 'g1', dimension: 'spelling', row: row(state(1e6, TODAY)) },
      ],
    });
    expect(summary.words[0].skills).toEqual([
      { dimension: 'written_productive', chance: 49, held: true },
      { dimension: 'spelling', chance: 99, held: false },
    ]);
  });

  it('takes the mean of the words, a word at its bar as 100, rounded down: an unpractised word pulls it down', () => {
    const summary = read({
      words: [
        { glossId: 'g1', live: SILENT },
        { glossId: 'g2', live: SILENT },
        { glossId: 'g3', live: SILENT },
      ],
      rows: [...rowsOf('g1', SILENT, row(AT_96)), ...rowsOf('g2', SILENT, row(AT_84))],
    });
    // (100 + 84 + 0) / 3 = 61.3.
    expect(summary.readinessPct).toBe(61);
    expect(summary.words.map((word) => word.readinessPct)).toEqual([100, 84, 0]);
  });

  it("a test's bar is 95: a word at 90 reads its own percent and is not ready (phase 67b D2)", () => {
    const summary = read({
      kind: 'exam',
      words: [
        { glossId: 'g1', live: SILENT },
        { glossId: 'g2', live: SILENT },
      ],
      rows: [...rowsOf('g1', SILENT, row(AT_96)), ...rowsOf('g2', SILENT, row(AT_90))],
    });
    expect(summary.words.map((word) => word.readinessPct)).toEqual([100, 90]);
    expect(summary.readinessPct).toBe(95);
    expect(summary.readyCount).toBe(1);
  });

  it("says whether a word's weakest skill is still open today: only it can move the word (phase 67b D1, D6)", () => {
    const open = (rows: { glossId: string; dimension: Dimension; row: ReadinessRow }[]) =>
      read({ words: [{ glossId: 'g1', live: SILENT }], rows }).words[0].weakestOpenToday;
    // The weakest, writing, answered today; spelling still open: answering spelling cannot raise the word.
    expect(
      open([
        { glossId: 'g1', dimension: 'written_productive', row: row(AT_84, { day: TODAY }) },
        { glossId: 'g1', dimension: 'spelling', row: row(AT_96, { day: '2026-10-14' }) },
      ]),
    ).toBe(false);
    // The weakest, writing, not answered today.
    expect(
      open([
        { glossId: 'g1', dimension: 'written_productive', row: row(AT_84, { day: '2026-10-14' }) },
        { glossId: 'g1', dimension: 'spelling', row: row(AT_96, { day: TODAY }) },
      ]),
    ).toBe(true);
    // Never answered: every skill at 0, none answered today.
    expect(open([])).toBe(true);
  });

  it('counts a word ready at 90 and above, and not below (spec D4)', () => {
    const ready = (memory: MemoryState) =>
      read({ words: [{ glossId: 'g1', live: ['written_productive'] }], rows: rowsOf('g1', ['written_productive'], row(memory)) }).readyCount;
    expect(ready(AT_90)).toBe(1);
    expect(ready(AT_96)).toBe(1);
    expect(ready(AT_84)).toBe(0);
    const two = read({
      words: ['g1', 'g2', 'g3'].map((glossId) => ({ glossId, live: ['written_productive'] as Dimension[] })),
      rows: [...rowsOf('g1', ['written_productive'], row(AT_90)), ...rowsOf('g2', ['written_productive'], row(AT_96)), ...rowsOf('g3', ['written_productive'], row(AT_84))],
    });
    expect(two.readyCount).toBe(2);
  });

  it('is 0 with no word', () => {
    expect(read()).toMatchObject({ readinessPct: 0, readinessStartPct: 0, readyCount: 0, words: [] });
  });
});

describe('readinessSummary: the start of today (spec D5, D10)', () => {
  it("reads each skill's first line today, its before, and the rest as they are", () => {
    const summary = read({
      words: [
        { glossId: 'g1', live: SILENT },
        { glossId: 'g2', live: SILENT },
      ],
      rows: [...rowsOf('g1', SILENT, row(AT_96, { day: TODAY })), ...rowsOf('g2', SILENT, row(AT_96))],
      firstToday: [
        { glossId: 'g1', dimension: 'written_productive', before: 0.5 },
        { glossId: 'g1', dimension: 'spelling', before: 0.5 },
      ],
    });
    // Now both words at 96, each counted 100; at the start of today g1 read 50.
    expect(summary.readinessPct).toBe(100);
    expect(summary.readinessStartPct).toBe(75);
  });

  it('is readiness itself on a day with no answer yet', () => {
    const summary = read({ words: [{ glossId: 'g1', live: SILENT }], rows: rowsOf('g1', SILENT, row(AT_96)) });
    expect(summary.readinessStartPct).toBe(summary.readinessPct);
  });
});

describe('canRaiseToday (phase 67b D6)', () => {
  const word = (over: Partial<{ readinessPct: number; met: boolean; weakestOpenToday: boolean }> = {}) => ({
    readinessPct: 60,
    met: true,
    weakestOpenToday: false,
    ...over,
  });
  const can = (words: ReturnType<typeof word>[], over: Partial<{ daysLeft: number; newRoom: number }> = {}) =>
    canRaiseToday({ daysLeft: 3, newRoom: 5, words, ...over });

  it('can while a word below its bar is not met yet and the day has room for new words', () => {
    expect(can([word({ met: false })])).toBe(true);
  });

  it('cannot when the only words below their bar are unmet and the day has no room left (Review focus 3)', () => {
    expect(can([word({ met: false })], { newRoom: 0 })).toBe(false);
    expect(can([word({ met: false })], { daysLeft: 1, newRoom: 0 })).toBe(false);
  });

  it("can before the eve while a met word below its bar has its weakest skill still open today", () => {
    expect(can([word({ weakestOpenToday: true })])).toBe(true);
  });

  it('cannot before the eve once the weakest skill of every word below its bar is answered today, another skill open or not (review C1)', () => {
    expect(can([word(), word({ readinessPct: 100, weakestOpenToday: true })])).toBe(false);
  });

  it('can on the eve while any met word is below its bar', () => {
    expect(can([word()], { daysLeft: 1 })).toBe(true);
  });

  it('cannot once every word is at its bar, on the eve too, nor on or after the date', () => {
    expect(can([word({ readinessPct: 100, weakestOpenToday: true })], { daysLeft: 1 })).toBe(false);
    expect(can([word({ weakestOpenToday: true })], { daysLeft: 0 })).toBe(false);
    expect(can([])).toBe(false);
  });
});

describe('readinessSummary on and after the due date (spec D3.7)', () => {
  it('reads the rows as stored, and a main memory moved on the date as no state, never as certain', () => {
    const summary = read({
      today: DUE,
      words: [{ glossId: 'g1', live: SILENT }],
      rows: [{ glossId: 'g1', dimension: 'written_productive', row: row(AT_96) }],
      // Practised on the date: FSRS would read it as certain.
      memory: [{ glossId: 'g1', dimension: 'spelling', state: state(3, DUE) }],
    });
    expect(summary.words[0].skills).toEqual([
      { dimension: 'written_productive', chance: 96, held: false },
      { dimension: 'spelling', chance: 0, held: false },
    ]);
  });

  it('reads a main memory last moved before the date as it was on the eve', () => {
    const summary = read({
      today: '2026-10-25',
      words: [{ glossId: 'g1', live: ['spelling'] }],
      memory: [{ glossId: 'g1', dimension: 'spelling', state: AT_90 }],
    });
    // 90, at the homework bar: the card counts it as 100.
    expect(summary.readinessPct).toBe(100);
    expect(summary.readinessStartPct).toBe(100);
  });
});

const day = (over: Partial<Parameters<typeof todaySummary>[0]> = {}) =>
  todaySummary({ plan: 'owed', daysLeft: 5, budget: null, offer: null, sessionsDone: 0, ...over });

describe('todaySummary (spec D7)', () => {
  it('is owed before the budget is met, with the budget and the sessions done', () => {
    expect(day({ budget: { sessions: 5, cards: 40 }, sessionsDone: 3 })).toEqual({
      state: 'owed',
      sessionsBudget: 5,
      sessionsOffer: 5,
      sessionsDone: 3,
      endedEarly: false,
      minutes: 20,
    });
  });

  it('is done once the budget is met, a word still owed', () => {
    expect(day({ budget: { sessions: 5, cards: 40 }, sessionsDone: 5 })).toMatchObject({ state: 'done', endedEarly: false });
    // A bonus session past it.
    expect(day({ budget: { sessions: 5, cards: 40 }, sessionsDone: 6 })).toMatchObject({ state: 'done', endedEarly: false, sessionsDone: 6 });
  });

  it('ended early when no word is owed after 3 of 5', () => {
    expect(day({ plan: 'done', budget: { sessions: 5, cards: 40 }, sessionsDone: 3 })).toMatchObject({ state: 'done', endedEarly: true });
  });

  it("offers the budget as it would be set now before the day's first session: no budget yet", () => {
    expect(day({ offer: { sessions: 4, cards: 9 } })).toEqual({
      state: 'owed',
      sessionsBudget: null,
      sessionsOffer: 4,
      sessionsDone: 0,
      endedEarly: false,
      // 9 cards at about 30 seconds each: 4.5, rounded.
      minutes: 5,
    });
  });

  it('is never done by a budget that was not set: a session started by its first answer leaves none', () => {
    expect(day({ offer: { sessions: 2, cards: 8 }, sessionsDone: 3 })).toMatchObject({ state: 'owed', sessionsBudget: null });
    expect(day({ plan: 'done', offer: { sessions: 2, cards: 8 }, sessionsDone: 3 })).toMatchObject({ state: 'done', endedEarly: true });
  });

  it("keeps the plan's rest", () => {
    expect(day({ plan: 'rest', offer: { sessions: 0, cards: 0 } })).toMatchObject({ state: 'rest', endedEarly: false, sessionsOffer: 0, minutes: 0 });
  });

  it('is due_today on and after the date, whatever the budget says', () => {
    expect(day({ daysLeft: 0, plan: 'due_today', budget: { sessions: 2, cards: 8 }, sessionsDone: 2 })).toMatchObject({ state: 'due_today', endedEarly: false });
    expect(day({ daysLeft: -3, plan: 'due_today' })).toMatchObject({ state: 'due_today', sessionsOffer: 0, minutes: 0 });
  });
});

describe('skillStarts (phase 67, spec D1)', () => {
  it("reads each counted skill at the start of today: its first line's before, else its row, else the main memory, else 0; and the day it last moved", () => {
    const starts = skillStarts({
      kind: 'homework',
      dueOn: DUE,
      words: [{ glossId: 'g1', live: HOMEWORK_LIVE }],
      rows: [{ glossId: 'g1', dimension: 'written_productive', row: row(AT_96, { day: TODAY }) }],
      memory: [{ glossId: 'g1', dimension: 'spelling', state: AT_90 }],
      firstToday: [{ glossId: 'g1', dimension: 'written_productive', before: 0.5 }],
    });
    expect(starts).toEqual([
      { glossId: 'g1', dimension: 'written_productive', chance: 0.5, movedOn: TODAY },
      { glossId: 'g1', dimension: 'spelling', chance: expect.closeTo(0.9, 4), movedOn: TODAY },
      { glossId: 'g1', dimension: 'spoken_productive', chance: 0, movedOn: null },
    ]);
  });

  it('reads every practised skill among the live ones, whatever the kind: an exam word, writing, spelling and speaking (phase 53 D3)', () => {
    const starts = skillStarts({ kind: 'exam', dueOn: DUE, words: [{ glossId: 'g1', live: HOMEWORK_LIVE }], rows: [], memory: [], firstToday: [] });
    expect(starts.map((start) => start.dimension)).toEqual(['written_productive', 'spelling', 'spoken_productive']);
    const silent = skillStarts({ kind: 'exam', dueOn: DUE, words: [{ glossId: 'g1', live: SILENT }], rows: [], memory: [], firstToday: [] });
    expect(silent.map((start) => start.dimension)).toEqual(['written_productive', 'spelling']);
  });
});

describe('pickNow (phase 67b D5)', () => {
  it("gives each word its card value now and its counted skills, the lowest chance first: a test's has no speaking", () => {
    const summary = read({
      kind: 'exam',
      words: [{ glossId: 'g1', live: HOMEWORK_LIVE }],
      rows: [
        { glossId: 'g1', dimension: 'written_productive', row: row(AT_96) },
        { glossId: 'g1', dimension: 'spelling', row: row(AT_84) },
        { glossId: 'g1', dimension: 'spoken_productive', row: row(state(1, '2026-09-01')) },
      ],
    });
    expect(pickNow(summary.words)).toEqual(new Map([['g1', { pct: 84, counted: ['spelling', 'written_productive'], weakestOpen: true }]]));
  });
});

import { describe, expect, it } from '@jest/globals';
import { FSRS6_DEFAULT, readinessFromMemory, type Dimension, type MemoryState, type ReadinessRow } from '@lang-tutor/core/domain';

import { readinessSummary, todaySummary } from './targetSummary';

// Phase 65 (spec D1, D3.7, D4, D7, D9, D10). The numbers a target's summary carries: its
// readiness, where today started, its ready words and whether more practice adds little; and
// today as a budget of sessions. Pure: every row and count is passed in.

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
  it("counts a homework word on write, spell and say, in the check's order, each from its row", () => {
    const summary = read({
      words: [{ glossId: 'g1', live: HOMEWORK_LIVE }],
      rows: [
        { glossId: 'g1', dimension: 'spoken_productive', row: row(AT_90) },
        { glossId: 'g1', dimension: 'written_productive', row: row(AT_96) },
        { glossId: 'g1', dimension: 'spelling', row: row(AT_96) },
        // Not counted: reading a word is not what the check asks.
        { glossId: 'g1', dimension: 'written_receptive', row: row(AT_84) },
      ],
    });
    expect(summary.words).toEqual([
      {
        glossId: 'g1',
        // 0.967 × 0.967 × 0.9 = 0.841.
        readinessPct: 84,
        skills: [
          { dimension: 'written_productive', chance: 96, held: false },
          { dimension: 'spelling', chance: 96, held: false },
          { dimension: 'spoken_productive', chance: 90, held: false },
        ],
      },
    ]);
    expect(summary.readinessPct).toBe(84);
  });

  it('drops speaking for a word that cannot be said: write and spell only, and not 0 (Review Focus 1)', () => {
    const summary = read({ words: [{ glossId: 'g1', live: SILENT }], rows: rowsOf('g1', ['written_productive', 'spelling'], row(AT_96)) });
    expect(summary.words[0].skills.map((skill) => skill.dimension)).toEqual(['written_productive', 'spelling']);
    expect(summary.words[0].readinessPct).toBe(93);
    expect(summary.readinessPct).toBe(93);
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

  it('takes the mean of the words, rounded down: an unpractised word pulls it down', () => {
    const summary = read({
      words: [
        { glossId: 'g1', live: SILENT },
        { glossId: 'g2', live: SILENT },
        { glossId: 'g3', live: SILENT },
      ],
      rows: [...rowsOf('g1', SILENT, row(AT_96)), ...rowsOf('g2', SILENT, row(AT_90))],
    });
    // (0.9346 + 0.81 + 0) / 3 = 0.5815.
    expect(summary.readinessPct).toBe(58);
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
    // Now (0.9346 + 0.9346) / 2; at the start of today (0.25 + 0.9346) / 2.
    expect(summary.readinessPct).toBe(93);
    expect(summary.readinessStartPct).toBe(59);
  });

  it('is readiness itself on a day with no answer yet', () => {
    const summary = read({ words: [{ glossId: 'g1', live: SILENT }], rows: rowsOf('g1', SILENT, row(AT_96)) });
    expect(summary.readinessStartPct).toBe(summary.readinessPct);
  });
});

describe('readinessSummary: practice more adds little (spec D9)', () => {
  it('is false on a day with first tries left', () => {
    const summary = read({ words: [{ glossId: 'g1', live: SILENT }] });
    expect(summary.practiceMoreLittle).toBe(false);
  });

  it('is true once every skill has had its first try today and both bonuses', () => {
    const spent = row(AT_84, { day: TODAY, bonusUsed: 2 });
    const summary = read({ words: [{ glossId: 'g1', live: SILENT }], rows: rowsOf('g1', SILENT, spent) });
    expect(summary.practiceMoreLittle).toBe(true);
  });

  it('is false while a bonus is left on a skill that is far from 100', () => {
    const summary = read({
      words: [{ glossId: 'g1', live: SILENT }],
      rows: [
        { glossId: 'g1', dimension: 'written_productive', row: row(state(1, TODAY), { day: TODAY, bonusUsed: 1 }) },
        { glossId: 'g1', dimension: 'spelling', row: row(state(1e6, TODAY), { day: TODAY, bonusUsed: 2 }) },
      ],
    });
    expect(summary.practiceMoreLittle).toBe(false);
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
    expect(summary.readinessPct).toBe(90);
    expect(summary.readinessStartPct).toBe(90);
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

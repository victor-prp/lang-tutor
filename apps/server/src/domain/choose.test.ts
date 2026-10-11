import { describe, expect, it } from '@jest/globals';
import { FSRS6_DEFAULT, SESSION_LENGTH, retrievability, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { chooseWords, expectedSuccess, type ChoiceInput, type ChosenPick } from './choose';
import { DAY_NEW_CAP, HARD_CAP, NEW_PER_SESSION, PER_DIMENSION_CAP, R_TARGET } from './chooseConstants';

// Not tests/support/testRng: ADR 0001 R3 greps domain/ for any parent-directory
// import, test files included. Same LCG.
function testRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

const TODAY = '2026-10-11';
const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SP: Dimension = 'spelling';
const SR: Dimension = 'spoken_receptive';
const SK: Dimension = 'spoken_productive';
const ALL: Dimension[] = [WR, WP, SP, SR, SK];

function daysBefore(day: string, n: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - n)).toISOString().slice(0, 10);
}

/** A state whose R today is `r`: reviewed today for r = 1, otherwise 100 days
 *  ago with the stability that leaves exactly `r`. */
function stateAt(r: number): MemoryState {
  const base = { difficulty: 5, reps: 3, lapses: 0, params: FSRS6_DEFAULT.id };
  if (r >= 1) return { ...base, stability: 10, lastDay: TODAY };
  const decay = FSRS6_DEFAULT.w[20];
  const factor = Math.pow(0.9, -1 / decay) - 1;
  return { ...base, stability: (factor * 100) / (Math.pow(r, -1 / decay) - 1), lastDay: daysBefore(TODAY, 100) };
}

type Word = {
  id: string;
  key?: string;
  savedAt?: string;
  /** R today per dimension; a dimension left out has no memory row. */
  memory?: Partial<Record<Dimension, number>>;
  levels?: Partial<Record<Dimension, number>>;
  state?: Partial<Record<Dimension, MemoryState>>;
};

const savedAt = (i: number) => `2026-01-01T00:${String(i).padStart(2, '0')}:00.000000Z`;

function input(words: Word[], over: Partial<ChoiceInput> = {}): ChoiceInput {
  return {
    saved: words.map((word, i) => ({ glossId: word.id, key: word.key ?? `key-${word.id}`, savedAt: word.savedAt ?? savedAt(i) })),
    memory: words.flatMap((word) => [
      ...Object.entries(word.memory ?? {}).map(([dimension, r]) => ({
        glossId: word.id,
        dimension: dimension as Dimension,
        state: stateAt(r),
      })),
      ...Object.entries(word.state ?? {}).map(([dimension, state]) => ({ glossId: word.id, dimension: dimension as Dimension, state })),
    ]),
    levels: words.flatMap((word) =>
      Object.entries(word.levels ?? {}).map(([dimension, level]) => ({ glossId: word.id, dimension: dimension as Dimension, level })),
    ),
    today: TODAY,
    askedToday: new Set(),
    newToday: 0,
    listening: true,
    speaking: true,
    rng: testRng(1),
    ...over,
  };
}

/** Every dimension at `r`, except those `low` names. */
const every = (r: number, low: Partial<Record<Dimension, number>> = {}) =>
  Object.fromEntries(ALL.map((dimension) => [dimension, low[dimension] ?? r])) as Record<Dimension, number>;

const known = (id: string, low: Partial<Record<Dimension, number>> = {}): Word => ({ id, memory: every(0.95, low) });
const fresh = (id: string, extra: Partial<Word> = {}): Word => ({ id, ...extra });
const ids = (picks: ChosenPick[]) => picks.map((pick) => pick.glossId);
const count = (picks: ChosenPick[], test: (pick: ChosenPick) => boolean) => picks.filter(test).length;
const range = (n: number, make: (i: number) => Word) => Array.from({ length: n }, (_, i) => make(i));

describe('stateAt, the fixture', () => {
  it('gives the R it was asked for', () => {
    expect(retrievability(stateAt(0.42), TODAY)).toBeCloseTo(0.42, 10);
  });
});

describe('expectedSuccess (spec D6, ruling 3)', () => {
  it('is g + (1 − g)·R^e: a guess floor for four options, the recognition exponent at rung 1', () => {
    expect(expectedSuccess(0.64, true, 1)).toBeCloseTo(0.25 + 0.75 * 0.8, 10);
    expect(expectedSuccess(0.64, false, 1)).toBeCloseTo(0.8, 10);
    expect(expectedSuccess(0.64, false, 2)).toBeCloseTo(0.64, 10);
    expect(expectedSuccess(0.64, true, 2)).toBeCloseTo(0.25 + 0.75 * 0.64, 10);
  });

  it('reads no R as 1', () => {
    expect(expectedSuccess(null, true, 1)).toBe(1);
    expect(expectedSuccess(null, false, 2)).toBe(1);
  });
});

describe('chooseWords (spec D5, D6)', () => {
  it('takes the classes in order: DUE, NEW, EXPAND, NOT_DUE, then what was asked today', () => {
    const picks = chooseWords(
      input(
        [
          known('not-due'),
          known('asked'),
          { id: 'expand', memory: { [WR]: 0.95 } },
          fresh('new'),
          known('due', { [WP]: 0.5 }),
        ],
        { askedToday: new Set(['asked']) },
      ),
    );
    expect(picks.map((pick) => [pick.glossId, pick.cls, pick.dimension])).toEqual([
      ['due', 'DUE', WP],
      ['new', 'NEW', WR],
      ['expand', 'EXPAND', WP],
      ['not-due', 'NOT_DUE', WR],
      ['asked', 'ASKED', WR],
    ]);
  });

  it('fills with more NEW after EXPAND and before NOT_DUE', () => {
    const picks = chooseWords(
      input([known('not-due', { [SP]: 0.93 }), { id: 'expand', memory: { [WR]: 0.95 } }, ...range(4, (i) => fresh(`n${i}`))]),
    );
    expect(picks.map((pick) => pick.cls)).toEqual(['NEW', 'NEW', 'NEW', 'EXPAND', 'NEW', 'NOT_DUE']);
  });

  it('expands into the next unintroduced live dimension in ORDER, at rung 1 with no R', () => {
    const [pick] = chooseWords(input([{ id: 'g', memory: { [WR]: 0.95, [WP]: 0.95 }, levels: { [SR]: 4 } }]));
    expect(pick).toEqual({ glossId: 'g', dimension: SR, rung: 1, level: 4, r: null, cls: 'EXPAND' });
  });

  it('asks DUE glosses by need ascending, each in its weakest live dimension', () => {
    const picks = chooseWords(
      input([known('a', { [WR]: 0.8 }), known('b', { [SP]: 0.3 }), known('c', { [WP]: 0.6, [WR]: 0.7 })]),
    );
    expect(picks.map((pick) => [pick.glossId, pick.dimension])).toEqual([
      ['b', SP],
      ['c', WP],
      ['a', WR],
    ]);
    for (const pick of picks) expect(pick.cls).toBe('DUE');
  });

  it('counts a word as DUE at exactly R_TARGET (ruling 11)', () => {
    const atTarget: MemoryState = { stability: 10, difficulty: 5, lastDay: daysBefore(TODAY, 10), reps: 2, lapses: 0, params: FSRS6_DEFAULT.id };
    expect(retrievability(atTarget, TODAY)).toBeLessThanOrEqual(R_TARGET);
    const [pick] = chooseWords(input([{ id: 'g', memory: every(0.95, {}), state: { [WR]: atTarget } }]));
    expect(pick).toMatchObject({ cls: 'DUE', dimension: WR });
  });

  it('asks a level-5 word whose R fell below 0.9: DUE, and at rung 2 while R is at least RUNG_R', () => {
    const levels = Object.fromEntries(ALL.map((dimension) => [dimension, 5]));
    const picks = chooseWords(input([{ ...known('g', { [WR]: 0.85 }), levels }]));
    expect(picks).toHaveLength(1);
    expect(picks[0]).toEqual({ glossId: 'g', dimension: WR, rung: 2, level: 5, r: expect.closeTo(0.85, 10), cls: 'DUE' });
  });

  it('chooses the rung by level and R: recall only at level 3 or more and R at least RUNG_R', () => {
    const rungOf = (level: number, r: number) =>
      chooseWords(input([{ ...known('g', { [WR]: r }), levels: { [WR]: level } }]))[0].rung;
    expect(rungOf(1, 0.85)).toBe(1);
    expect(rungOf(2, 0.85)).toBe(1);
    expect(rungOf(3, 0.85)).toBe(2);
    expect(rungOf(3, 0.7)).toBe(1);
    expect(rungOf(5, 0.5)).toBe(1);
    // No level row reads as level 1.
    expect(chooseWords(input([known('g', { [WR]: 0.85 })]))[0]).toMatchObject({ level: 1, rung: 1 });
  });

  describe('NEW', () => {
    it('gets at least two when the daily cap allows, however many words are due', () => {
      // Twelve DUE words in four dimensions, three each: no cap is reached by eight of them.
      const due = range(12, (i) => known(`d${i}`, { [[WP, SP, SR, SK][i % 4]]: 0.5 }));
      const picks = chooseWords(input([...due, ...range(5, (i) => fresh(`n${i}`))]));
      expect(picks).toHaveLength(SESSION_LENGTH);
      expect(count(picks, (pick) => pick.cls === 'NEW')).toBe(2);
      expect(count(picks, (pick) => pick.cls === 'DUE')).toBe(8);
    });

    it('takes three when DUE leaves room, and no more while other words can fill the session', () => {
      // Seven EXPAND words in four dimensions: WP, SR, SP and SK each next for some.
      const next: Partial<Record<Dimension, number>>[] = [
        { [WR]: 0.95 },
        { [WR]: 0.95, [WP]: 0.95 },
        { [WR]: 0.95, [WP]: 0.95, [SR]: 0.95 },
        { [WR]: 0.95, [WP]: 0.95, [SR]: 0.95, [SP]: 0.95 },
      ];
      const expand = range(7, (i) => ({ id: `x${i}`, memory: next[i % 4] }));
      const picks = chooseWords(input([...expand, ...range(10, (i) => fresh(`n${i}`))]));
      expect(picks).toHaveLength(SESSION_LENGTH);
      expect(count(picks, (pick) => pick.cls === 'NEW')).toBe(NEW_PER_SESSION);
      expect(count(picks, (pick) => pick.cls === 'EXPAND')).toBe(7);
    });

    it('stops at the daily cap of DAY_NEW_CAP while other words can fill the session', () => {
      const others = range(10, (i) => known(`k${i}`, { [ALL[i % 5]]: 0.93 }));
      const words = [...range(10, (i) => fresh(`n${i}`)), ...others];
      const atCapLessOne = chooseWords(input(words, { newToday: DAY_NEW_CAP - 1 }));
      expect(atCapLessOne).toHaveLength(SESSION_LENGTH);
      expect(count(atCapLessOne, (pick) => pick.cls === 'NEW')).toBe(1);
      const atCap = chooseWords(input(words, { newToday: DAY_NEW_CAP }));
      expect(atCap).toHaveLength(SESSION_LENGTH);
      expect(count(atCap, (pick) => pick.cls === 'NEW')).toBe(0);
    });

    // Ruling 15. A session is never left short while saved glosses remain.
    it('goes past the daily cap as a last resort, after every other class', () => {
      const words = [known('a', { [WP]: 0.93 }), known('b', { [SP]: 0.93 }), ...range(3, (i) => fresh(`n${i}`))];
      const picks = chooseWords(input(words, { newToday: DAY_NEW_CAP }));
      expect(picks.map((pick) => pick.glossId)).toEqual(['a', 'b', 'n2', 'n1', 'n0']);
    });

    it('fills an all-NEW list at or past the daily cap', () => {
      const words = range(12, (i) => fresh(`n${i}`));
      for (const newToday of [DAY_NEW_CAP - 2, DAY_NEW_CAP, DAY_NEW_CAP + 5]) {
        const picks = chooseWords(input(words, { newToday }));
        expect(ids(picks)).toEqual(Array.from({ length: 10 }, (_, i) => `n${11 - i}`));
      }
      expect(chooseWords(input(words.slice(0, 3), { newToday: DAY_NEW_CAP }))).toHaveLength(3);
    });

    it('fills an all-NEW list: the newest saved first, every one written receptive at rung 1', () => {
      const picks = chooseWords(input(range(12, (i) => fresh(`n${i}`))));
      expect(ids(picks)).toEqual(Array.from({ length: 10 }, (_, i) => `n${11 - i}`));
      for (const pick of picks) expect(pick).toMatchObject({ cls: 'NEW', dimension: WR, rung: 1, level: 1, r: null });
    });

    it('breaks ties of equal save time with the injected rng, reproducibly', () => {
      const words = range(6, (i) => fresh(`n${i}`, { savedAt: savedAt(0) }));
      const orders = new Set<string>();
      for (let seed = 1; seed <= 10; seed++) {
        const first = ids(chooseWords(input(words, { rng: testRng(seed) })));
        expect(ids(chooseWords(input(words, { rng: testRng(seed) })))).toEqual(first);
        orders.add(first.join());
      }
      expect(orders.size).toBeGreaterThan(1);
    });
  });

  it('leaves glosses asked today for last, even a due one', () => {
    const words = [known('due', { [WR]: 0.3 }), ...range(10, (i) => known(`k${i}`, { [[WR, WP, SP, SR, SK][i % 5]]: 0.93 }))];
    const picks = chooseWords(input(words, { askedToday: new Set(['due']) }));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(ids(picks)).not.toContain('due');
    const few = chooseWords(input(words.slice(0, 3), { askedToday: new Set(['due']) }));
    expect(few.map((pick) => [pick.glossId, pick.cls])).toEqual([
      ['k0', 'NOT_DUE'],
      ['k1', 'NOT_DUE'],
      ['due', 'ASKED'],
    ]);
  });

  it('tests one dimension in at most PER_DIMENSION_CAP picks while others can fill the session', () => {
    // A newly capable device: eight words due for listening, and written words not due.
    const spoken = range(8, (i) => known(`s${i}`, { [SR]: 0.4 }));
    const written = range(6, (i) => known(`w${i}`, { [[WR, WP, SP][i % 3]]: 0.92 }));
    const picks = chooseWords(input([...spoken, ...written]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(count(picks, (pick) => pick.dimension === SR)).toBe(PER_DIMENSION_CAP);
  });

  it('asks at most HARD_CAP picks whose best card is expected to succeed below 0.6', () => {
    // R 0.19 at rung 1: 0.25 + 0.75·√0.19 ≈ 0.58.
    expect(expectedSuccess(0.19, true, 1)).toBeLessThan(0.6);
    const hard = range(8, (i) => known(`h${i}`, { [[WR, WP, SP, SR][i % 4]]: 0.19 }));
    const easy = range(6, (i) => known(`e${i}`, { [[WR, WP, SP][i % 3]]: 0.92 }));
    const picks = chooseWords(input([...hard, ...easy]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(count(picks, (pick) => expectedSuccess(pick.r, pick.rung === 1, pick.rung) < 0.6)).toBe(HARD_CAP);
  });

  it('chooses spoken receptive only when listening, and spoken productive only when speaking', () => {
    const words = [
      known('sr', { [SR]: 0.2 }),
      known('sk', { [SK]: 0.2 }),
      { id: 'written', memory: { [WR]: 0.95, [WP]: 0.95, [SP]: 0.95 } },
      { id: 'only-sr', memory: { [SR]: 0.95 } },
    ];
    const dimensions = (listening: boolean, speaking: boolean) =>
      new Set(chooseWords(input(words, { listening, speaking })).map((pick) => pick.dimension));
    const quiet = dimensions(false, false);
    expect(quiet.has(SR) || quiet.has(SK)).toBe(false);
    expect(dimensions(true, false).has(SK)).toBe(false);
    expect(dimensions(true, false).has(SR)).toBe(true);
    expect(dimensions(false, true).has(SR)).toBe(false);
    expect(dimensions(false, true).has(SK)).toBe(true);
    // Without listening, a word known only by ear has nothing live: it expands into WR.
    expect(chooseWords(input(words, { listening: false, speaking: false })).find((pick) => pick.glossId === 'only-sr')).toMatchObject({
      cls: 'EXPAND',
      dimension: WR,
    });
  });

  it('gives three picks for three saved words', () => {
    const picks = chooseWords(input([fresh('n'), known('d', { [WR]: 0.5 }), known('k')]));
    expect(ids(picks).sort()).toEqual(['d', 'k', 'n']);
  });

  it('gives a list of fewer than ten new words one pick each', () => {
    expect(chooseWords(input(range(4, (i) => fresh(`n${i}`))))).toHaveLength(4);
  });

  it('picks one gloss per normalised key, the neediest', () => {
    const picks = chooseWords(
      input([
        { ...known('order'), key: 'לְהַזְמִין' },
        { ...known('reserve', { [WP]: 0.4 }), key: 'להזמין' },
        { ...known('book'), key: 'לְהַזְמִין' },
        fresh('cook', { key: 'לבשל' }),
      ]),
    );
    expect(ids(picks).sort()).toEqual(['cook', 'reserve']);
  });

  it('never asks one key twice when everything is new', () => {
    const picks = chooseWords(input([fresh('a', { key: 'Book' }), fresh('b', { key: 'book ' }), fresh('c', { key: 'pen' })]));
    expect(picks).toHaveLength(2);
  });
});

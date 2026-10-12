import { describe, expect, it } from '@jest/globals';
import { FSRS6_DEFAULT, SESSION_LENGTH, retrievability, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { chooseWords, expectedSuccess, liveDimensions, rungFor, type ChoiceInput, type ChosenPick } from './choose';
import { DAY_NEW_CAP, HARD_CAP, NEW_PER_SESSION, PER_DIMENSION_CAP, RUNG_R, R_TARGET } from './chooseConstants';
import type { Step } from './today';

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

const NO_FAMILIES = { familyOf: new Map<string, number>(), waiting: new Set<string>() };

const savedAt = (i: number) => `2026-01-01T00:${String(i).padStart(2, '0')}:00.000000Z`;

/** Speaking is off unless a test turns it on: the speaking pick (phase 37 D4) has
 *  tests of its own. */
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
    steps: [],
    done: new Set(),
    newToday: 0,
    listening: true,
    speaking: false,
    rng: testRng(1),
    families: NO_FAMILIES,
    ...over,
  };
}

/** Every dimension at `r`, except those `low` names. */
const every = (r: number, low: Partial<Record<Dimension, number>> = {}) =>
  Object.fromEntries(ALL.map((dimension) => [dimension, low[dimension] ?? r])) as Record<Dimension, number>;

const known = (id: string, low: Partial<Record<Dimension, number>> = {}): Word => ({ id, memory: every(0.95, low) });
const fresh = (id: string, extra: Partial<Word> = {}): Word => ({ id, ...extra });
/** A return owed (D1), opened at answer `opened`. */
const step = (glossId: string, dimension: Dimension, opened = 0): Step => ({ glossId, dimension, opened });
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

describe('rungFor (phase 37 D2)', () => {
  it('is recall from RUNG_R up with memory, and recognition below it or with none', () => {
    expect(rungFor(RUNG_R)).toBe(2);
    expect(rungFor(1)).toBe(2);
    expect(rungFor(RUNG_R - 0.001)).toBe(1);
    expect(rungFor(null)).toBe(1);
  });
});

describe('liveDimensions (phase 39 D2)', () => {
  it('is ORDER, with listening and speaking only when on', () => {
    expect(liveDimensions(false, false)).toEqual([WR, WP, SP]);
    expect(liveDimensions(true, false)).toEqual([WR, WP, SR, SP]);
    expect(liveDimensions(false, true)).toEqual([WR, WP, SP, SK]);
    expect(liveDimensions(true, true)).toEqual([WR, WP, SR, SP, SK]);
  });
});

describe('chooseWords (spec D5, D6; phase 37 D3)', () => {
  it('takes the classes in order: NEW, STEP, DUE, EXPAND, NOT_DUE, then DONE', () => {
    const picks = chooseWords(
      input(
        [
          known('not-due'),
          known('done'),
          { id: 'expand', memory: { [WR]: 0.95 } },
          fresh('new'),
          { id: 'step', memory: { [WR]: 1 } },
          known('due', { [WP]: 0.5 }),
        ],
        { steps: [step('step', WR)], done: new Set(['done']) },
      ),
    );
    expect(picks.map((pick) => [pick.glossId, pick.cls, pick.dimension])).toEqual([
      ['new', 'NEW', WR],
      ['step', 'STEP', WR],
      ['due', 'DUE', WP],
      ['expand', 'EXPAND', WP],
      ['not-due', 'NOT_DUE', WR],
      ['done', 'DONE', WR],
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

  it('chooses the rung by memory, not level: recall from RUNG_R up, recognition below it or untested', () => {
    const rungOf = (level: number, r: number) =>
      chooseWords(input([{ ...known('g', { [WR]: r }), levels: { [WR]: level } }]))[0].rung;
    expect(rungOf(1, 0.85)).toBe(2);
    expect(rungOf(2, 0.85)).toBe(2);
    expect(rungOf(3, 0.7)).toBe(1);
    expect(rungOf(5, 0.5)).toBe(1);
    expect(chooseWords(input([fresh('g')]))[0]).toMatchObject({ rung: 1, r: null });
    expect(chooseWords(input([{ id: 'g', memory: { [WR]: 0.95 } }]))[0]).toMatchObject({ cls: 'EXPAND', rung: 1, r: null });
  });

  it('asks a return at rung 2 in its owed dimension, whatever its R', () => {
    const [pick] = chooseWords(input([{ id: 'g', memory: { [WR]: 0.5, [WP]: 0.95 } }], { steps: [step('g', WR)] }));
    expect(pick).toEqual({ glossId: 'g', dimension: WR, rung: 2, level: 1, r: expect.closeTo(0.5, 10), cls: 'STEP' });
  });

  describe('NEW', () => {
    it('gets NEW_FLOOR, one, under a backlog of due words', () => {
      const due = range(12, (i) => known(`d${i}`, { [[WR, WP, SP, SR][i % 4]]: 0.5 }));
      const picks = chooseWords(input([...due, ...range(5, (i) => fresh(`n${i}`))]));
      expect(picks).toHaveLength(SESSION_LENGTH);
      expect(count(picks, (pick) => pick.cls === 'NEW')).toBe(1);
      expect(count(picks, (pick) => pick.cls === 'DUE')).toBe(9);
    });

    it('is never held back by the per-skill limit: with four due words in WR, a new word still comes first', () => {
      const wr = range(4, (i) => known(`r${i}`, { [WR]: 0.3 }));
      const wp = range(4, (i) => known(`p${i}`, { [WP]: 0.4 }));
      const picks = chooseWords(
        input([...wr, ...wp, known('due-sp', { [SP]: 0.5 }), { id: 'expand', memory: { [WR]: 0.95, [WP]: 0.95 } }, known('not-due'), fresh('n0'), fresh('n1')]),
      );
      expect(picks.map((pick) => [pick.glossId, pick.cls])).toEqual([
        ['n1', 'NEW'],
        ...wr.map((word) => [word.id, 'DUE']),
        ...wp.map((word) => [word.id, 'DUE']),
        ['due-sp', 'DUE'],
      ]);
    });

    it('takes NEW_PER_SESSION first when the due words leave room, and no more while other words fill the session', () => {
      // Seven EXPAND words into WP, SR and SP, none over the per-skill limit.
      const next: Partial<Record<Dimension, number>>[] = [{ [WR]: 0.95 }, { [WR]: 0.95, [WP]: 0.95 }, { [WR]: 0.95, [WP]: 0.95, [SR]: 0.95 }];
      const expand = range(7, (i) => ({ id: `x${i}`, memory: next[i % 3] }));
      const picks = chooseWords(input([...expand, ...range(10, (i) => fresh(`n${i}`))]));
      expect(picks).toHaveLength(SESSION_LENGTH);
      expect(picks.slice(0, NEW_PER_SESSION).map((pick) => pick.cls)).toEqual(Array(NEW_PER_SESSION).fill('NEW'));
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

    it('goes past the daily cap only for a session that would otherwise be empty', () => {
      const words = [known('a', { [WP]: 0.93 }), known('b', { [SP]: 0.93 }), ...range(3, (i) => fresh(`n${i}`))];
      expect(ids(chooseWords(input(words, { newToday: DAY_NEW_CAP })))).toEqual(['a', 'b']);
      // An all-NEW list: what the cap allows below it, and a full session at or past it.
      const all = range(12, (i) => fresh(`n${i}`));
      expect(ids(chooseWords(input(all, { newToday: DAY_NEW_CAP - 2 })))).toEqual(['n11', 'n10']);
      for (const newToday of [DAY_NEW_CAP, DAY_NEW_CAP + 5]) {
        expect(ids(chooseWords(input(all, { newToday })))).toEqual(Array.from({ length: 10 }, (_, i) => `n${11 - i}`));
      }
      expect(chooseWords(input(all.slice(0, 3), { newToday: DAY_NEW_CAP }))).toHaveLength(3);
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

  describe('returns (phase 37 D1)', () => {
    it('come before a DUE word, however much less known that word is', () => {
      const picks = chooseWords(input([known('due', { [WP]: 0.2 }), { id: 'step', memory: { [WR]: 1 } }], { steps: [step('step', WR)] }));
      expect(picks.map((pick) => [pick.glossId, pick.cls])).toEqual([
        ['step', 'STEP'],
        ['due', 'DUE'],
      ]);
    });

    it('wait while their dimension is not live, asked only as a word done today when nothing else is left', () => {
      const heard: Word = { id: 'heard', memory: { [WR]: 1, [SR]: 1 } };
      const listeningOff = { steps: [step('heard', SR)], listening: false };
      expect(ids(chooseWords(input([heard, ...range(10, (i) => known(`k${i}`))], listeningOff)))).not.toContain('heard');
      // A one-word list: a session is never empty while a word is saved.
      expect(chooseWords(input([heard], listeningOff))).toEqual([{ glossId: 'heard', dimension: WP, rung: 1, level: 1, r: null, cls: 'DONE' }]);
    });

    it('take their key: a sibling with the same key is not asked too', () => {
      const picks = chooseWords(
        input([{ ...known('due', { [WP]: 0.2 }), key: 'לְהַזְמִין' }, { id: 'step', key: 'להזמין', memory: { [WR]: 1 } }], {
          steps: [step('step', WR)],
        }),
      );
      expect(ids(picks)).toEqual(['step']);
    });
  });

  describe('DONE (phase 37 D3)', () => {
    it('is asked only after every other word, a due one included', () => {
      const words = [known('due', { [WR]: 0.3 }), ...range(10, (i) => known(`k${i}`, { [[WR, WP, SP, SR, SK][i % 5]]: 0.93 }))];
      const picks = chooseWords(input(words, { done: new Set(['due']) }));
      expect(picks).toHaveLength(SESSION_LENGTH);
      expect(ids(picks)).not.toContain('due');
      const few = chooseWords(input(words.slice(0, 3), { done: new Set(['due']) }));
      expect(few.map((pick) => [pick.glossId, pick.cls])).toEqual([
        ['k0', 'NOT_DUE'],
        ['k1', 'NOT_DUE'],
        ['due', 'DONE'],
      ]);
    });

    it('comes after what the hard cap held back', () => {
      const hard = range(HARD_CAP + 1, (i) => known(`h${i}`, { [WR]: 0.19 }));
      const picks = chooseWords(input([...hard, known('done')], { done: new Set(['done']) }));
      expect(picks.map((pick) => [pick.glossId, pick.cls])).toEqual([...hard.map((word) => [word.id, 'DUE']), ['done', 'DONE']]);
    });

    it('comes in the order today gives it: the least practised first', () => {
      const words = [known('a'), known('b'), known('c')];
      expect(ids(chooseWords(input(words, { done: new Set(['c', 'a', 'b']) })))).toEqual(['c', 'a', 'b']);
    });

    it('fills a session before a new word past the daily cap', () => {
      const picks = chooseWords(input([known('a'), known('b'), fresh('n')], { done: new Set(['a', 'b']), newToday: DAY_NEW_CAP }));
      expect(ids(picks)).toEqual(['a', 'b']);
    });
  });

  describe('the per-skill limit (phase 37 D3)', () => {
    it('holds back expansions past PER_DIMENSION_CAP while others can fill the session', () => {
      // A newly capable device: eight words to introduce to listening, and written words not due.
      const spoken = range(8, (i) => ({ id: `s${i}`, memory: { [WR]: 0.95, [WP]: 0.95 } }));
      const written = range(6, (i) => known(`w${i}`, { [[WR, WP, SP][i % 3]]: 0.92 }));
      const picks = chooseWords(input([...spoken, ...written]));
      expect(picks).toHaveLength(SESSION_LENGTH);
      expect(count(picks, (pick) => pick.dimension === SR)).toBe(PER_DIMENSION_CAP);
    });

    it('never holds back a due word', () => {
      const spoken = range(8, (i) => known(`s${i}`, { [SR]: 0.4 }));
      const written = range(2, (i) => known(`w${i}`, { [WR]: 0.92 }));
      const picks = chooseWords(input([...spoken, ...written]));
      expect(picks).toHaveLength(SESSION_LENGTH);
      expect(count(picks, (pick) => pick.dimension === SR)).toBe(8);
    });
  });

  describe('the speaking pick (phase 37 D4)', () => {
    const speaking = { speaking: true };

    it('takes a return in SK first', () => {
      const picks = chooseWords(
        input([known('due-sk', { [SK]: 0.4 }), { id: 'sk-step', memory: { [WR]: 1, [SK]: 1 } }, known('other')], {
          ...speaking,
          steps: [step('sk-step', SK)],
        }),
      );
      expect(picks[0]).toMatchObject({ glossId: 'sk-step', cls: 'STEP', dimension: SK, rung: 2 });
    });

    it('then the least known word due in SK, keeping its class', () => {
      const picks = chooseWords(input([known('sk-a', { [SK]: 0.6 }), known('sk-b', { [SK]: 0.4 }), known('wr', { [WR]: 0.3 })], speaking));
      expect(picks.map((pick) => [pick.glossId, pick.cls, pick.dimension])).toEqual([
        ['sk-b', 'DUE', SK],
        ['wr', 'DUE', WR],
        ['sk-a', 'DUE', SK],
      ]);
    });

    it('then the least known word not due with no SK memory, moved to SK at rung 1', () => {
      const picks = chooseWords(
        input([{ id: 'met-b', memory: { [WR]: 0.97 } }, { id: 'met-a', memory: { [WR]: 0.92 } }, known('other')], speaking),
      );
      expect(picks[0]).toEqual({ glossId: 'met-a', dimension: SK, rung: 1, level: 1, r: null, cls: 'SPEAK' });
      expect(count(picks, (pick) => pick.dimension === SK)).toBe(1);
    });

    it('then a word done today with no SK memory, moved to SK, before a due word is', () => {
      const picks = chooseWords(
        input([{ id: 'due', memory: { [WR]: 0.5 } }, { id: 'done', memory: { [WR]: 1 } }], { ...speaking, done: new Set(['done']) }),
      );
      expect(picks.map((pick) => [pick.glossId, pick.cls, pick.dimension])).toEqual([
        ['done', 'SPEAK', SK],
        ['due', 'DUE', WR],
      ]);
    });

    it('then, with every word due, the best known one with no SK memory', () => {
      const picks = chooseWords(
        input([{ id: 'd1', memory: { [WR]: 0.3 } }, { id: 'd2', memory: { [WR]: 0.8 } }, { id: 'd3', memory: { [WR]: 0.6 } }], speaking),
      );
      expect(picks.map((pick) => [pick.glossId, pick.cls, pick.dimension])).toEqual([
        ['d2', 'SPEAK', SK],
        ['d1', 'DUE', WR],
        ['d3', 'DUE', WR],
      ]);
    });

    it('is not made for a one-word session, nor from words never met', () => {
      expect(chooseWords(input([{ id: 'met', memory: { [WR]: 0.95 } }], speaking))[0]).toMatchObject({ cls: 'EXPAND', dimension: WP });
      const picks = chooseWords(input(range(4, (i) => fresh(`n${i}`)), speaking));
      expect(count(picks, (pick) => pick.dimension === SK)).toBe(0);
    });
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

describe('families (phase 39 D5)', () => {
  const family = (members: Record<string, number>, waiting: string[] = []) => ({
    families: { familyOf: new Map(Object.entries(members)), waiting: new Set(waiting) },
  });

  it('never picks a waiting gloss, in any pass', () => {
    const speaking = { speaking: true };
    const words = [fresh('new'), known('due', { [WR]: 0.4 }), { id: 'ret', memory: { [WR]: 1 } }, known('other'), known('done')];
    const picks = chooseWords(
      input(words, { ...speaking, steps: [step('ret', WR)], done: new Set(['done']), ...family({}, ['new', 'due', 'ret', 'done']) }),
    );
    expect(ids(picks)).toEqual(['other']);
  });

  it('reaches the speaking pass without taking a waiting gloss', () => {
    // 'w' is the best speaking candidate (least known, silent in SK) but waits.
    const words = [{ id: 'w', memory: { [WR]: 0.9 } }, { id: 'x', memory: { [WR]: 0.95 } }, { id: 'y', memory: { [WR]: 0.97 } }];
    const picks = chooseWords(input(words, { speaking: true, ...family({}, ['w']) }));
    expect(ids(picks).sort()).toEqual(['x', 'y']);
    expect(picks.some((pick) => pick.cls === 'SPEAK')).toBe(true);
  });

  it('picks one of two new glosses of a family', () => {
    expect(chooseWords(input([fresh('a'), fresh('b')], family({ a: 1, b: 1 })))).toHaveLength(1);
  });

  it('picks one of two due glosses of a family', () => {
    const picks = chooseWords(input([known('a', { [WR]: 0.4 }), known('b', { [WR]: 0.3 })], family({ a: 1, b: 1 })));
    expect(ids(picks)).toEqual(['b']);
  });

  it('picks one of a new and a due gloss of a family', () => {
    expect(chooseWords(input([fresh('a'), known('b', { [WR]: 0.4 })], family({ a: 1, b: 1 })))).toHaveLength(1);
  });

  it('lets a return claim its family ahead of a new gloss', () => {
    const picks = chooseWords(input([{ id: 'a', memory: { [WR]: 1 } }, fresh('b')], { steps: [step('a', WR)], ...family({ a: 1, b: 1 }) }));
    expect(ids(picks)).toEqual(['a']);
  });

  it('never gives the speaking pick a family a return claimed', () => {
    const picks = chooseWords(
      input([{ id: 'a', memory: { [WR]: 1 } }, known('b', { [SK]: 0.3 }), known('c')], {
        speaking: true,
        steps: [step('a', WR)],
        ...family({ a: 1, b: 1 }),
      }),
    );
    expect(ids(picks)).not.toContain('b');
    expect(ids(picks)).toContain('a');
  });

  it('picks the earlier opened of two returns in a family', () => {
    const words = [{ id: 'a', memory: { [WR]: 1 } }, { id: 'b', memory: { [WR]: 1 } }];
    const picks = chooseWords(input(words, { steps: [step('a', WR, 5), step('b', WR, 2)], ...family({ a: 1, b: 1 }) }));
    expect(ids(picks)).toEqual(['b']);
  });

  it('never picks a done gloss whose family is taken', () => {
    const picks = chooseWords(input([known('a', { [WR]: 0.4 }), known('b')], { done: new Set(['b']), ...family({ a: 1, b: 1 }) }));
    expect(ids(picks)).toEqual(['a']);
  });

  it('counts groups, not glosses, for the length of a session', () => {
    const members = Object.fromEntries(range(12, (i) => ({ id: `m${i}` })).map((w, i) => [w.id, Math.floor(i / 4)]));
    const words = [...range(12, (i) => fresh(`m${i}`)), fresh('s1'), fresh('s2')];
    expect(chooseWords(input(words, { newToday: 0, ...family(members) }))).toHaveLength(5);
  });

  it('asks no speaking pick of a session that can hold only one (n counts the family once)', () => {
    // Three glosses of one family, distinct keys, each silent in SK: counting keys
    // alone gives n = 3 and a speaking pick; one family gives n = 1 and none.
    const words = range(3, (i) => ({ id: `g${i}`, memory: { [WR]: 0.95 } }));
    const picks = chooseWords(input(words, { speaking: true, ...family({ g0: 1, g1: 1, g2: 1 }) }));
    expect(picks).toHaveLength(1);
    expect(picks[0].cls).toBe('EXPAND');
  });

  it('still picks one when every gloss is in one family', () => {
    const words = range(6, (i) => fresh(`g${i}`));
    const members = Object.fromEntries(words.map((w) => [w.id, 7]));
    expect(chooseWords(input(words, family(members)))).toHaveLength(1);
  });
});

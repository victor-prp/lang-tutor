import { describe, expect, it } from '@jest/globals';
import { FSRS6_DEFAULT, SESSION_LENGTH, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { choosePools, chooseWords, expectedSuccess, type ChoiceInput, type ChosenPick } from './choose';
import { DAY_NEW_CAP, HARD_CAP, NEW_FLOOR, PER_DIMENSION_CAP } from './chooseConstants';
import { chooseWithTargets, targetSplit, type ActiveTarget, type TargetSessionInput } from './targetSession';
import { owedNew, type TargetKind } from './targets';
import type { Step } from './today';

// The builders are choose.test.ts's, copied: ADR 0001 R3 greps domain/ for any
// parent-directory import, test files included, and a test is no module to import.
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
  state?: Partial<Record<Dimension, MemoryState>>;
};

const NO_FAMILIES = { familyOf: new Map<string, number>(), waiting: new Set<string>() };

const savedAt = (i: number) => `2026-01-01T00:${String(i).padStart(2, '0')}:00.000000Z`;

/** Speaking is off unless a test turns it on. */
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
    levels: [],
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

// Phase 53's own.

/** Reviewed today with a stability of 1000 days in each skill a session without speaking
 *  asks: ready for any date these tests set, and not due today. */
const READY: MemoryState = { stability: 1000, difficulty: 5, lastDay: TODAY, reps: 5, lapses: 0, params: FSRS6_DEFAULT.id };
const ready = (id: string): Word => ({ id, state: { [WR]: READY, [WP]: READY, [SR]: READY, [SP]: READY } });
/** Met in every skill but speaking, none of them due. */
const heard = (id: string): Word => ({ id, memory: { [WR]: 0.95, [WP]: 0.95, [SR]: 0.95, [SP]: 0.95 } });

const unmet = (n: number) => range(n, (i) => fresh(`t${i}`));
const mains = (n: number) => range(n, (i) => known(`m${i}`));
const idsOf = (words: readonly Word[]) => words.map((word) => word.id);
const of = (picks: ChosenPick[], words: readonly Word[]) => picks.filter((pick) => idsOf(words).includes(pick.glossId));

/** A target due `daysLeft` days after TODAY. */
const target = (id: string, kind: TargetKind, daysLeft: number, words: readonly Word[]): ActiveTarget => ({
  id,
  kind,
  dueOn: daysBefore(TODAY, -daysLeft),
  glossIds: idsOf(words),
});

/** Every gloss speakable and none met today, unless a test says otherwise. */
function session(
  words: Word[],
  targets: ActiveTarget[],
  over: Partial<ChoiceInput> = {},
  rest: Partial<Pick<TargetSessionInput, 'speakable' | 'introducedToday'>> = {},
): TargetSessionInput {
  return { choice: input(words, over), targets, speakable: new Map(), introducedToday: new Set(), ...rest };
}

describe('chooseWithTargets (spec D5–D7, rulings R-D6, R-D7)', () => {
  it('with no target, chooses exactly as chooseWords does and splits nothing', () => {
    const lists: [Word[], Partial<ChoiceInput>][] = [
      // A fresh list whose save times tie, so the rng orders it.
      [range(14, (i) => fresh(`n${i}`, { savedAt: savedAt(i % 4) })), {}],
      // Due words of every need, beside new ones.
      [[...range(12, (i) => known(`d${i}`, { [[WR, WP, SP, SR][i % 4]]: 0.2 + 0.05 * i })), ...range(4, (i) => fresh(`n${i}`))], {}],
      // Returns, one in speaking, a word done today and a family a return claims.
      [
        [{ id: 'r0', memory: { [WR]: 1 } }, { id: 'r1', memory: { [WR]: 1, [SK]: 1 } }, known('done'), known('kin', { [WP]: 0.4 }), ...mains(8), fresh('n0')],
        {
          speaking: true,
          steps: [step('r1', SK, 0), step('r0', WR, 1)],
          done: new Set(['done']),
          families: { familyOf: new Map([['r0', 1], ['kin', 1]]), waiting: new Set<string>() },
        },
      ],
    ];
    for (const [words, over] of lists) {
      const { picks, split } = chooseWithTargets(session(words, [], over));
      expect(picks.length).toBeGreaterThan(0);
      expect(picks).toEqual(chooseWords(input(words, over)));
      expect(split).toEqual([]);
    }
  });

  it('gives an exam whose words are all unmet every slot', () => {
    const exam = unmet(20);
    const { picks, split } = chooseWithTargets(session([...exam, ...mains(30)], [target('exam', 'exam', 10, exam)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, exam)).toHaveLength(SESSION_LENGTH);
    expect(split).toEqual([{ targetId: 'exam', wish: 10, slots: 10, picked: 10, reason: 'not_ready', daysLeft: 10, readyCount: 0, wordCount: 20 }]);
  });

  it('gives an exam whose every word is ready its steady five, and the main path the other five', () => {
    const exam = range(20, (i) => ready(`t${i}`));
    const { picks, split } = chooseWithTargets(session([...exam, ...mains(30)], [target('exam', 'exam', 10, exam)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, exam)).toHaveLength(5);
    expect(split).toEqual([{ targetId: 'exam', wish: 5, slots: 5, picked: 5, reason: 'steady', daysLeft: 10, readyCount: 20, wordCount: 20 }]);
  });

  it.each<[TargetKind, number, number]>([
    ['homework', 5, 3],
    ['exam', 10, 5],
  ])('gives a ready %s holding every saved word a full session: its share, then the slots the main path left', (kind, daysLeft, steady) => {
    const words = range(20, (i) => ready(`t${i}`));
    const { picks, split } = chooseWithTargets(session(words, [target('only', kind, daysLeft, words)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, words)).toHaveLength(SESSION_LENGTH);
    expect(split).toEqual([
      { targetId: 'only', wish: steady, slots: steady, picked: SESSION_LENGTH, reason: 'steady', daysLeft, readyCount: 20, wordCount: 20 },
    ]);
  });

  it('gives the slots the main path leaves back in pool order: the target due first takes them first', () => {
    const homework = range(20, (i) => ready(`h${i}`));
    const exam = range(20, (i) => ready(`e${i}`));
    const { split } = chooseWithTargets(
      session([...homework, ...exam], [target('exam', 'exam', 10, exam), target('hw', 'homework', 5, homework)]),
    );
    // First pass 3 and 5; the 2 the empty main path leaves go to the homework, due first.
    expect(split.map(({ targetId, slots, picked }) => ({ targetId, slots, picked }))).toEqual([
      { targetId: 'hw', slots: 3, picked: 5 },
      { targetId: 'exam', slots: 5, picked: 5 },
    ]);
  });

  it("asks a word done today only when no pool has another: a steady homework takes the slots the main path's done words would fill", () => {
    const homework = range(10, (i) => ready(`t${i}`));
    const main = mains(10);
    const { picks, split } = chooseWithTargets(
      session([...homework, ...main], [target('hw', 'homework', 5, homework)], { done: new Set(idsOf(main)) }),
    );
    expect(ids(picks).sort()).toEqual(idsOf(homework).sort());
    expect(split[0]).toMatchObject({ slots: 3, picked: 10 });
  });

  it("fills a target's slots with its own words answered today before the main path's new words: target only until ready", () => {
    const unmetFour = range(4, (i) => fresh(`t${i}`));
    const answered = range(16, (i) => ({ id: `a${i}`, memory: { [WR]: 1 } }));
    const exam = [...unmetFour, ...answered];
    const news = range(10, (i) => fresh(`n${i}`));
    const { picks, split } = chooseWithTargets(
      session([...exam, ...news], [target('exam', 'exam', 10, exam)], { done: new Set(idsOf(answered)) }),
    );
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, unmetFour)).toHaveLength(4);
    expect(of(picks, answered)).toHaveLength(6);
    expect(of(picks, news)).toHaveLength(0);
    expect(split[0]).toMatchObject({ reason: 'not_ready', slots: 10, picked: 10 });
  });

  it("lets a steady target take its share from its own words answered today; the main path's new words fill the rest", () => {
    const homework = range(10, (i) => ready(`t${i}`));
    const news = range(10, (i) => fresh(`n${i}`));
    const { picks, split } = chooseWithTargets(
      session([...homework, ...news], [target('hw', 'homework', 5, homework)], { done: new Set(idsOf(homework)) }),
    );
    expect(of(picks, homework).map((pick) => pick.cls)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(of(picks, news).map((pick) => pick.cls)).toEqual(Array(7).fill('NEW'));
    expect(split[0]).toMatchObject({ reason: 'steady', slots: 3, picked: 3 });
  });

  it('leaves the main path its share while it has words not done today: the steady homework keeps its three', () => {
    const homework = range(10, (i) => ready(`t${i}`));
    const news = range(10, (i) => fresh(`n${i}`));
    const answered = mains(10);
    const { picks, split } = chooseWithTargets(
      session([...homework, ...news, ...answered], [target('hw', 'homework', 5, homework)], { done: new Set(idsOf(answered)) }),
    );
    expect(of(picks, homework)).toHaveLength(3);
    expect(of(picks, news)).toHaveLength(7);
    expect(split[0]).toMatchObject({ slots: 3, picked: 3 });
  });

  it('gives an exam the day before its date every slot, and a homework none', () => {
    const exam = unmet(20);
    const homework = range(5, (i) => fresh(`h${i}`));
    const both = session([...exam, ...homework, ...mains(30)], [target('hw', 'homework', 5, homework), target('exam', 'exam', 1, exam)]);
    const { picks, split } = chooseWithTargets(both);
    expect(of(picks, exam)).toHaveLength(SESSION_LENGTH);
    // In the order the pools run: the nearer date first.
    expect(split).toEqual([
      { targetId: 'exam', wish: 10, slots: 10, picked: 10, reason: 'exclusive', daysLeft: 1, readyCount: 0, wordCount: 20 },
      { targetId: 'hw', wish: 10, slots: 0, picked: 0, reason: 'not_ready', daysLeft: 5, readyCount: 0, wordCount: 5 },
    ]);
    // Spec D12: the split alone, as the stale check reads it, is the same with nothing picked.
    expect(targetSplit(both)).toEqual(split.map((row) => ({ ...row, picked: 0 })));
  });

  it('hands the slots a target cannot fill to the main path: three words wishing ten', () => {
    const homework = unmet(3);
    const { picks, split } = chooseWithTargets(session([...homework, ...mains(30)], [target('hw', 'homework', 5, homework)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, homework)).toHaveLength(3);
    expect(split[0]).toMatchObject({ wish: 10, slots: 10, picked: 3 });
  });

  it('asks a gloss in two targets once, for the one due first, and counts it in both', () => {
    const shared = fresh('shared');
    const sooner = [shared, fresh('a1'), fresh('a2')];
    const later = [shared, fresh('b1'), fresh('b2')];
    const { picks, split } = chooseWithTargets(
      session([shared, fresh('a1'), fresh('a2'), fresh('b1'), fresh('b2'), ...mains(30)], [
        target('later', 'homework', 6, later),
        target('sooner', 'exam', 4, sooner),
      ]),
    );
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(count(picks, (pick) => pick.glossId === 'shared')).toBe(1);
    expect(split.map(({ targetId, slots, picked, wordCount }) => ({ targetId, slots, picked, wordCount }))).toEqual([
      { targetId: 'sooner', slots: 5, picked: 3, wordCount: 3 },
      { targetId: 'later', slots: 5, picked: 2, wordCount: 3 },
    ]);
  });

  it('serves two targets due the same day in id order', () => {
    const shared = fresh('shared');
    const { split } = chooseWithTargets(
      session([shared, ...mains(30)], [target('b', 'homework', 3, [shared]), target('a', 'homework', 3, [shared])]),
    );
    expect(split.map(({ targetId, picked }) => ({ targetId, picked }))).toEqual([
      { targetId: 'a', picked: 1 },
      { targetId: 'b', picked: 0 },
    ]);
  });

  it('passes the speaking pick on: a target of words never met cannot make it, so the main path does', () => {
    const homework = unmet(4);
    const main = range(10, (i) => heard(`m${i}`));
    const { picks } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)], { speaking: true }));
    expect(of(picks, homework).map((pick) => pick.cls)).toEqual(['NEW', 'NEW', 'NEW', 'NEW']);
    const spoken = picks.filter((pick) => pick.cls === 'SPEAK');
    expect(spoken).toHaveLength(1);
    expect(idsOf(main)).toContain(spoken[0].glossId);
  });

  it('makes one speaking pick a session: the first pool that can, and no pool after it', () => {
    const homework = range(4, (i) => ({ id: `t${i}`, memory: { [WR]: 0.95 } }));
    const main = range(10, (i) => heard(`m${i}`));
    const { picks } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)], { speaking: true }));
    const spoken = picks.filter((pick) => pick.cls === 'SPEAK');
    expect(spoken).toHaveLength(1);
    expect(idsOf(homework)).toContain(spoken[0].glossId);
  });

  it('never asks a target word and a main word of one family, or of one key, in one session', () => {
    const homework = unmet(3);
    // The main path's two neediest words: one of t0's family, one of t1's key.
    const main = [known('kin', { [WR]: 0.3 }), { ...known('twin', { [WR]: 0.35 }), key: 'KEY-t1 ' }, ...mains(12)];
    const families = { familyOf: new Map([['t0', 1], ['kin', 1]]), waiting: new Set<string>() };
    const { picks } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)], { families }));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(ids(picks)).toEqual(expect.arrayContaining(['t0', 't1']));
    expect(ids(picks)).not.toContain('kin');
    expect(ids(picks)).not.toContain('twin');
  });

  it('keeps a family for the return that claimed it, whichever pool holds the return', () => {
    const homework = unmet(3);
    const main = [{ id: 'ret', memory: { [WR]: 1 } }, ...mains(12)];
    const families = { familyOf: new Map([['t0', 1], ['ret', 1]]), waiting: new Set<string>() };
    const { picks } = chooseWithTargets(
      session([...homework, ...main], [target('hw', 'homework', 5, homework)], { steps: [step('ret', WR)], families }),
    );
    expect(ids(picks)).toContain('ret');
    expect(ids(picks)).not.toContain('t0');
  });

  it('lets a target keep its pace past the daily cap, while the main path meets no new word', () => {
    const others = [...range(5, (i) => fresh(`n${i}`)), ...mains(30)];
    const exam = unmet(20);
    const { picks, split } = chooseWithTargets(session([...exam, ...others], [target('exam', 'exam', 2, exam)], { newToday: DAY_NEW_CAP }));
    expect(of(picks, exam).filter((pick) => pick.cls === 'NEW')).toHaveLength(SESSION_LENGTH);
    expect(split[0]).toMatchObject({ reason: 'run_up', slots: 10, picked: 10 });
    // A smaller list leaves the main path slots: it fills them with no new word of its own.
    const few = unmet(6);
    const short = chooseWithTargets(session([...few, ...others], [target('exam', 'exam', 2, few)], { newToday: DAY_NEW_CAP }));
    expect(short.picks).toHaveLength(SESSION_LENGTH);
    expect(ids(short.picks.filter((pick) => pick.cls === 'NEW')).sort()).toEqual(idsOf(few).sort());
  });

  it("counts a target's new words toward the daily cap: what the target spends, the main path does not get", () => {
    const exam = unmet(10);
    expect(owedNew(10, 0, 20)).toBe(1);
    const others = [...range(5, (i) => fresh(`n${i}`)), ...mains(30)];
    const { picks } = chooseWithTargets(session([...exam, ...others], [target('exam', 'exam', 20, exam)], { newToday: DAY_NEW_CAP - 2 }));
    expect(picks).toHaveLength(SESSION_LENGTH);
    const introduced = picks.filter((pick) => pick.cls === 'NEW');
    expect(introduced).toHaveLength(2);
    expect(of(introduced, exam)).toHaveLength(2);
  });

  it("keeps the main path's own new-word floor after a target's new words", () => {
    const homework = unmet(3);
    const backlog = range(12, (i) => known(`d${i}`, { [[WR, WP, SP, SR][i % 4]]: 0.5 }));
    const news = range(5, (i) => fresh(`n${i}`));
    const { picks } = chooseWithTargets(session([...homework, ...backlog, ...news], [target('hw', 'homework', 5, homework)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, homework)).toHaveLength(3);
    expect(of(picks, news)).toHaveLength(NEW_FLOOR);
  });

  it('paces by the words met today too (spec D7)', () => {
    // Three days left: two to meet 14 words in, 4 of them met today, so 3 more today.
    expect(owedNew(10, 4, 3)).toBe(3);
    const metToday = range(4, (i) => ({ id: `met${i}`, memory: { [WR]: 1 } }));
    const exam = [...unmet(10), ...metToday];
    const met = new Set(idsOf(metToday));
    const { picks } = chooseWithTargets(
      session([...exam, ...mains(30)], [target('exam', 'exam', 3, exam)], { newToday: DAY_NEW_CAP, done: met }, { introducedToday: met }),
    );
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(count(picks, (pick) => pick.cls === 'NEW')).toBe(3);
  });

  it("keeps a target's pace across both passes: past the daily cap, no more new words than it owes", () => {
    // Every saved word is the homework's, so the main path leaves its slots unpicked.
    expect(owedNew(20, 0, 11)).toBe(2);
    const homework = unmet(20);
    const { picks, split } = chooseWithTargets(session(homework, [target('hw', 'homework', 11, homework)], { newToday: DAY_NEW_CAP }));
    expect(picks.map((pick) => pick.cls)).toEqual(['NEW', 'NEW']);
    expect(split[0]).toMatchObject({ slots: 10, picked: 2 });
  });

  it('leaves no session empty while a word can be asked: new words past the cap come from a target too', () => {
    // A random input the first version left empty. g1, the one word that can be asked, is
    // new and only the exam's; the cap is spent; the exam owes no new word today, since
    // g0 was met today; and g0 waits (phase 39).
    const words = [{ id: 'g0', memory: { [WR]: 0.95, [SP]: 0.5, [SR]: 0.1, [SK]: 0.1 } }, fresh('g1', { key: 'run' })];
    const families = { familyOf: new Map<string, number | string>([['g0', 'f2'], ['g1', 0]]), waiting: new Set(['g0']) };
    const targets = [target('x0', 'homework', 13, [words[0]]), target('x1', 'homework', 9, []), target('x2', 'exam', 14, words)];
    expect(owedNew(1, 1, 14)).toBe(0);
    const { picks, split } = chooseWithTargets(
      session(words, targets, { newToday: DAY_NEW_CAP + 3, listening: false, speaking: true, families }, { introducedToday: new Set(['g0']) }),
    );
    expect(picks).toEqual([{ glossId: 'g1', dimension: WR, rung: 1, level: 1, r: null, cls: 'NEW' }]);
    expect(split.map(({ targetId, picked }) => ({ targetId, picked }))).toEqual([
      { targetId: 'x1', picked: 0 },
      { targetId: 'x0', picked: 0 },
      { targetId: 'x2', picked: 1 },
    ]);
  });

  it('reads a word that cannot be said as ready without speaking (ruling R-D4)', () => {
    const exam = range(5, (i) => ready(`t${i}`));
    const words = [...exam, ...mains(30)];
    const targets = [target('exam', 'exam', 10, exam)];
    const mute = new Map(idsOf(exam).map((id) => [id, false]));
    expect(targetSplit(session(words, targets, { speaking: true }))[0]).toMatchObject({ readyCount: 0, reason: 'not_ready' });
    expect(targetSplit(session(words, targets, { speaking: true }, { speakable: mute }))[0]).toMatchObject({ readyCount: 5, reason: 'steady' });
    // Without speaking live, no word needs it.
    expect(targetSplit(session(words, targets))[0]).toMatchObject({ readyCount: 5, reason: 'steady' });
  });

  it('counts the hard cap over the whole session', () => {
    // R 0.19 at rung 1: 0.25 + 0.75·√0.19 ≈ 0.58, below 0.6.
    const homework = range(HARD_CAP, (i) => known(`t${i}`, { [WR]: 0.19 }));
    const main = [...range(HARD_CAP, (i) => known(`h${i}`, { [WP]: 0.19 })), ...range(SESSION_LENGTH, (i) => known(`m${i}`, { [SP]: 0.92 }))];
    const { picks } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, homework)).toHaveLength(HARD_CAP);
    expect(count(picks, (pick) => expectedSuccess(pick.r, pick.rung === 1, pick.rung) < 0.6)).toBe(HARD_CAP);
  });

  it('counts the per-skill limit over the whole session', () => {
    // Met in writing only: each expands into listening.
    const writing = (id: string): Word => ({ id, memory: { [WR]: 0.95, [WP]: 0.95 } });
    const homework = range(PER_DIMENSION_CAP, (i) => writing(`t${i}`));
    const main = [...range(PER_DIMENSION_CAP, (i) => writing(`s${i}`)), ...range(SESSION_LENGTH, (i) => known(`m${i}`, { [SP]: 0.92 }))];
    const { picks } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, homework)).toHaveLength(PER_DIMENSION_CAP);
    expect(count(picks, (pick) => pick.dimension === SR)).toBe(PER_DIMENSION_CAP);
  });
});

describe('choosePools (ruling R-D6)', () => {
  it('asks in the main path (null) only words no other pool lists; the slots it leaves go back to the pools', () => {
    const words = [known('a', { [WR]: 0.3 }), known('b', { [WR]: 0.4 }), known('c'), known('d')];
    const [listed, main] = choosePools(input(words), [
      { glossIds: new Set(['a', 'b']), slots: 1, owedNew: 0 },
      { glossIds: null, slots: SESSION_LENGTH - 1, owedNew: 0 },
    ]);
    // The first pass gives the listing pool its one slot, a; the second gives it b.
    expect(ids(listed)).toEqual(['a', 'b']);
    expect(ids(main).sort()).toEqual(['c', 'd']);
  });

  it('hands the slots a pool leaves forward in the first pass: the next pool runs with them', () => {
    // a's two new words leave three of its five slots; with them, b's one-slot pool can hold
    // the session's speaking pick, ahead of the main path.
    const b = range(3, (i) => ({ id: `b${i}`, memory: { [WR]: 0.95 } }));
    const words = [fresh('a1'), fresh('a2'), ...b, ...range(6, (i) => heard(`m${i}`))];
    const [first, second, main] = choosePools(input(words, { speaking: true }), [
      { glossIds: new Set(['a1', 'a2']), slots: 5, owedNew: 0 },
      { glossIds: new Set(idsOf(b)), slots: 1, owedNew: 0 },
      { glossIds: null, slots: 4, owedNew: 0 },
    ]);
    expect(ids(first)).toEqual(['a2', 'a1']);
    expect(second.map((pick) => pick.cls)).toEqual(['SPEAK', 'EXPAND', 'EXPAND']);
    expect(main.map((pick) => pick.cls)).not.toContain('SPEAK');
  });

  it("asks a pool's words a cap held back before its words answered today (phase 37 D3)", () => {
    // R 0.19 at rung 1 is a hard card: six such words, two over HARD_CAP, and three answered today.
    const hard = range(HARD_CAP + 2, (i) => known(`h${i}`, { [WR]: 0.19 }));
    const answered = range(3, (i) => known(`d${i}`));
    const listed = [...hard, ...answered];
    const [first] = choosePools(input([...listed, ...mains(10)], { done: new Set(idsOf(answered)) }), [
      { glossIds: new Set(idsOf(listed)), slots: 8, owedNew: 0 },
      { glossIds: null, slots: SESSION_LENGTH - 8, owedNew: 0 },
    ]);
    expect(ids(first)).toEqual([...idsOf(hard), 'd0', 'd1']);
  });

  it("fills a listing pool's slots with its words answered today before passing any on; the main path's come last", () => {
    const listed = [known('a0'), known('a1'), known('d0'), known('d1'), known('d2')];
    const others = range(8, (i) => known(`m${i}`));
    const answered = range(5, (i) => known(`e${i}`));
    const done = new Set(['d0', 'd1', 'd2', ...idsOf(answered)]);
    const pools = (slots: number) => [
      { glossIds: new Set(idsOf(listed)), slots, owedNew: 0 },
      { glossIds: null, slots: SESSION_LENGTH - slots, owedNew: 0 },
    ];
    // Five slots: its two words, then its three answered today, though the main path has words to spare.
    expect(choosePools(input([...listed, ...others, ...answered], { done }), pools(5)).map(ids)).toEqual([
      ['a0', 'a1', 'd0', 'd1', 'd2'],
      ['m0', 'm1', 'm2', 'm3', 'm4'],
    ]);
    // Three slots: d1 and d2 come back to it in the second pass, before the main path's words answered today.
    expect(choosePools(input([...listed, ...others.slice(0, 3), ...answered], { done }), pools(3)).map(ids)).toEqual([
      ['a0', 'a1', 'd0', 'd1', 'd2'],
      ['m0', 'm1', 'm2', 'e0', 'e1'],
    ]);
  });

  it("counts a word whose family a return claimed in its pool's lists, and never picks it (ruling 1: claims apply when picking)", () => {
    // d is due, but r's return claims their family. Counted as due, d leaves room for two new
    // words before r; left out of the lists, it would leave room for three.
    const words = [{ id: 'r', memory: { [WR]: 1 } }, known('d', { [WP]: 0.4 }), ...range(3, (i) => fresh(`f${i}`))];
    const families = { familyOf: new Map([['r', 1], ['d', 1]]), waiting: new Set<string>() };
    const picks = chooseWords(input(words, { steps: [step('r', WR)], families }));
    expect(picks.map((pick) => [pick.glossId, pick.cls])).toEqual([
      ['f2', 'NEW'],
      ['f1', 'NEW'],
      ['r', 'STEP'],
      ['f0', 'NEW'],
    ]);
  });

  it('with one pool, adds nothing in the second pass: a pool gives no more picks than the groups it first held', () => {
    // A key bridges a's family to c, so the three count as one group (phase 39): the first
    // pass stops at a, and c, free as it is, waits for another session.
    const words = [{ id: 'a', memory: { [WR]: 1 } }, { ...known('b', { [WP]: 0.4 }), key: 'k2' }, { ...known('c'), key: 'k2' }];
    const families = { familyOf: new Map([['a', 1], ['b', 1]]), waiting: new Set<string>() };
    expect(ids(chooseWords(input(words, { steps: [step('a', WR)], families })))).toEqual(['a']);
  });

  it("leaves a word an earlier pool took out of a later pool's lists: it holds back none of that pool's new words", () => {
    const later = [known('x', { [WR]: 0.3 }), ...range(3, (i) => fresh(`n${i}`)), ...range(5, (i) => ({ id: `e${i}`, memory: { [WR]: 0.95 } }))];
    // The main path fills its own slots, so no second pass comes back to the second pool.
    const [first, second] = choosePools(input([...later, ...mains(6)]), [
      { glossIds: new Set(['x']), slots: 1, owedNew: 0 },
      { glossIds: new Set(idsOf(later)), slots: 3, owedNew: 0 },
      { glossIds: null, slots: SESSION_LENGTH - 4, owedNew: 0 },
    ]);
    expect(ids(first)).toEqual(['x']);
    // Still counted as a due word to ask, x would shrink the second pool's new-word reserve to two.
    expect(second.map((pick) => pick.cls)).toEqual(['NEW', 'NEW', 'NEW']);
  });

  it('goes past the daily cap only for a session still empty after the second pass, from the pools in order', () => {
    const capSpent = { newToday: DAY_NEW_CAP };
    const pools = (first: string, slots = 1) => [
      { glossIds: new Set([first]), slots, owedNew: 0 },
      { glossIds: null, slots: SESSION_LENGTH - slots, owedNew: 0 },
    ];
    const news = range(3, (i) => fresh(`n${i}`));
    // A pool before it picked: the main path's new words wait.
    expect(choosePools(input([known('a', { [WR]: 0.3 }), ...news], capSpent), pools('a')).map(ids)).toEqual([['a'], []]);
    // A pool with no slot of its own picks in the second pass: still no new word past the cap.
    expect(choosePools(input([known('a'), ...news], capSpent), pools('a', 0)).map(ids)).toEqual([['a'], []]);
    // Nothing picked in either pass: new words past the cap, each pool's in turn.
    expect(choosePools(input(news, capSpent), pools('n0')).map(ids)).toEqual([['n0'], ['n2', 'n1']]);
  });
});

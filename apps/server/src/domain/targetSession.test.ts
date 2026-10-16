import { describe, expect, it } from '@jest/globals';
import { FSRS6_DEFAULT, SESSION_LENGTH, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { choosePools, chooseWords, expectedSuccess, type ChoiceInput, type ChosenPick } from './choose';
import { DAY_NEW_CAP, HARD_CAP, LADDER_SLOTS, NEW_FLOOR, NEW_PER_SESSION, PER_DIMENSION_CAP } from './chooseConstants';
import { chooseWithTargets, splitChanged, targetSplit, type ActiveTarget, type TargetSessionInput, type TargetSplit } from './targetSession';
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

const NO_FAMILIES = { familyOf: new Map<string, number>(), waiting: new Set<string>(), newMeanings: new Set<string>() };

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
/** READY in every skill, speaking included: ready with speaking live, and no speaking pick. */
const readyAloud = (id: string): Word => ({ id, state: { [WR]: READY, [WP]: READY, [SR]: READY, [SP]: READY, [SK]: READY } });
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
          families: { familyOf: new Map([['r0', 1], ['kin', 1]]), waiting: new Set<string>(), newMeanings: new Set<string>() },
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

  it('gives a fresh homework of thirty words every slot: two ladders, and no main-path pick though the main path has words (phase 55, spec D5)', () => {
    const homework = unmet(30);
    const { picks, split } = chooseWithTargets(session([...homework, ...mains(30)], [target('hw', 'homework', 5, homework)]));
    // Two ladders take eight slots and are the session's ceiling; the two left stay off the main path.
    expect(picks.map((pick) => [pick.glossId, pick.cls, pick.ladder])).toEqual([
      ['t29', 'NEW', true],
      ['t28', 'NEW', true],
    ]);
    expect(split).toEqual([
      { targetId: 'hw', wish: 10, slots: 10, picked: 2, reason: 'not_ready', daysLeft: 5, readyCount: 0, wordCount: 30 },
    ]);
  });

  it("passes a target's unused slots to the later targets, never to the main path (phase 55, spec D5)", () => {
    const first = unmet(1);
    const second = range(10, (i) => ready(`r${i}`));
    const { picks, split } = chooseWithTargets(
      session([...first, ...second, ...mains(30)], [target('first', 'homework', 3, first), target('second', 'homework', 5, second)]),
    );
    // The first's eight slots hold its one ladder, four; the second, steady, asks for three and is
    // given two, and takes the first's four with them: six words. The main path's share is none.
    expect(split.map(({ targetId, wish, slots, picked }) => ({ targetId, wish, slots, picked }))).toEqual([
      { targetId: 'first', wish: 10, slots: 8, picked: 1 },
      { targetId: 'second', wish: 3, slots: 2, picked: 6 },
    ]);
    expect(picks).toHaveLength(7);
    expect(of(picks, mains(30))).toHaveLength(0);
  });

  it("passes an empty target's slots on to the main path, before or after a target that leaves some (phase 55, spec D5)", () => {
    const words = unmet(1);
    for (const [emptyDays, wordsDays] of [
      [3, 5],
      [5, 3],
    ]) {
      const { picks, split } = chooseWithTargets(
        session([...words, ...mains(30)], [target('empty', 'homework', emptyDays, []), target('words', 'homework', wordsDays, words)]),
      );
      // The empty target's steady three are given two; the other's eight hold one ladder. The main
      // path takes the empty target's two, and none of the four the other leaves.
      const byId = Object.fromEntries(split.map(({ targetId, slots, picked }) => [targetId, { slots, picked }]));
      expect({ emptyDays, byId, main: of(picks, mains(30)).length }).toEqual({
        emptyDays,
        byId: { empty: { slots: 2, picked: 0 }, words: { slots: 8, picked: 1 } },
        main: 2,
      });
    }
  });

  it("gives the main path's own unused slots back to a target: a main path of two words in a share of seven", () => {
    const homework = range(10, (i) => ready(`t${i}`));
    const main = mains(2);
    const { picks, split } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, main)).toHaveLength(2);
    expect(split[0]).toMatchObject({ reason: 'steady', slots: 3, picked: 8 });
  });

  it("shows no main-path pick on a small exam's eve: what the exam leaves stays off the main path (phase 55, spec D5)", () => {
    // Two words never met, two ladders and two slots left; three words met, three picks and seven left.
    for (const exam of [unmet(2), range(3, (i) => known(`t${i}`))]) {
      const { picks, split } = chooseWithTargets(session([...exam, ...mains(30)], [target('exam', 'exam', 1, exam)]));
      expect({ words: exam.length, picks: picks.length, main: of(picks, mains(30)).length }).toEqual({ words: exam.length, picks: exam.length, main: 0 });
      expect(split[0]).toMatchObject({ reason: 'exclusive', slots: SESSION_LENGTH, picked: exam.length });
    }
  });

  it('gives an exam whose every word is ready its steady five, and the main path the other five', () => {
    const exam = range(20, (i) => ready(`t${i}`));
    const { picks, split } = chooseWithTargets(session([...exam, ...mains(30)], [target('exam', 'exam', 10, exam)]));
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, exam)).toHaveLength(5);
    expect(split).toEqual([{ targetId: 'exam', wish: 5, slots: 5, picked: 5, reason: 'steady', daysLeft: 10, readyCount: 20, wordCount: 20 }]);
  });

  it('gives an exam with some of its words ready a graded share: 12 of 20 ready ask for 7, the main path takes 3', () => {
    const exam = [...range(12, (i) => ready(`t${i}`)), ...range(8, (i) => fresh(`u${i}`))];
    const { picks, split } = chooseWithTargets(session([...exam, ...mains(30)], [target('exam', 'exam', 10, exam)]));
    // Phase 55 (spec D4): the exam's seven slots are one ladder and three ready words.
    expect(picks).toHaveLength(7);
    expect(of(picks, exam).map((pick) => pick.cls)).toEqual(['NEW', 'NOT_DUE', 'NOT_DUE', 'NOT_DUE']);
    expect(split).toEqual([{ targetId: 'exam', wish: 7, slots: 7, picked: 4, reason: 'not_ready', daysLeft: 10, readyCount: 12, wordCount: 20 }]);
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
    // Phase 55 (spec D4): two ladders, the session's ceiling, take eight slots; two words
    // answered today take the rest.
    const rest = SESSION_LENGTH - NEW_PER_SESSION * LADDER_SLOTS;
    expect(picks).toHaveLength(NEW_PER_SESSION + rest);
    expect(of(picks, unmetFour)).toHaveLength(NEW_PER_SESSION);
    expect(of(picks, answered)).toHaveLength(rest);
    expect(of(picks, news)).toHaveLength(0);
    expect(split[0]).toMatchObject({ reason: 'not_ready', slots: 10, picked: NEW_PER_SESSION + rest });
  });

  it("lets a steady target take its share from its own words answered today; the main path's new words take theirs, and what they leave comes back", () => {
    const homework = range(10, (i) => ready(`t${i}`));
    const news = range(10, (i) => fresh(`n${i}`));
    const { picks, split } = chooseWithTargets(
      session([...homework, ...news], [target('hw', 'homework', 5, homework)], { done: new Set(idsOf(homework)) }),
    );
    // Phase 55 (spec D4): the main path's seven slots hold one ladder; the three left, too few
    // for a second, come back to the homework in the second pass.
    expect(of(picks, homework).map((pick) => pick.cls)).toEqual(Array(6).fill('DONE'));
    expect(of(picks, news).map((pick) => pick.cls)).toEqual(['NEW']);
    expect(split[0]).toMatchObject({ reason: 'steady', slots: 3, picked: 6 });
  });

  it('leaves the main path its share while it has words not done today: the steady homework keeps its three, and what the main path leaves', () => {
    const homework = range(10, (i) => ready(`t${i}`));
    const news = range(10, (i) => fresh(`n${i}`));
    const answered = mains(10);
    const { picks, split } = chooseWithTargets(
      session([...homework, ...news, ...answered], [target('hw', 'homework', 5, homework)], { done: new Set(idsOf(answered)) }),
    );
    // Phase 55 (spec D4): the main path's seven slots hold one ladder; the three left, too few
    // for a second, go back to the homework before the main path's words answered today.
    expect(of(picks, homework)).toHaveLength(6);
    expect(of(picks, news)).toHaveLength(1);
    expect(of(picks, answered)).toHaveLength(0);
    expect(split[0]).toMatchObject({ slots: 3, picked: 6 });
  });

  it('gives an exam the day before its date every slot, and a homework none', () => {
    const exam = unmet(20);
    const homework = range(5, (i) => fresh(`h${i}`));
    const both = session([...exam, ...homework, ...mains(30)], [target('hw', 'homework', 5, homework), target('exam', 'exam', 1, exam)]);
    const { picks, split } = chooseWithTargets(both);
    // Phase 55 (spec D4, D5): two ladders, the session's ceiling, eight of its slots; the two left
    // pass to the homework, which no ladder fits, and never to the main path.
    expect(picks).toHaveLength(NEW_PER_SESSION);
    expect(of(picks, exam)).toHaveLength(NEW_PER_SESSION);
    expect(of(picks, homework)).toHaveLength(0);
    // In the order the pools run: the nearer date first.
    expect(split).toEqual([
      { targetId: 'exam', wish: 10, slots: 10, picked: NEW_PER_SESSION, reason: 'exclusive', daysLeft: 1, readyCount: 0, wordCount: 20 },
      { targetId: 'hw', wish: 10, slots: 0, picked: 0, reason: 'not_ready', daysLeft: 5, readyCount: 0, wordCount: 5 },
    ]);
    // Spec D12: the split alone, as the stale check reads it, is the same with nothing picked.
    expect(targetSplit(both)).toEqual(split.map((row) => ({ ...row, picked: 0 })));
  });

  it('keeps the slots a target cannot fill off the main path: one word wishing ten is its ladder alone (phase 55, spec D5)', () => {
    const homework = unmet(1);
    const { picks, split } = chooseWithTargets(session([...homework, ...mains(30)], [target('hw', 'homework', 5, homework)]));
    expect(ids(picks)).toEqual(['t0']);
    expect(split[0]).toMatchObject({ wish: 10, slots: 10, picked: 1 });
  });

  it('asks a gloss in two targets once, for the one due first, and counts it in both', () => {
    // Phase 54: the shared gloss saved last, so the sooner target's one ladder is it.
    const shared = fresh('shared');
    const sooner = [shared, fresh('a1'), fresh('a2')];
    const later = [shared, fresh('b1'), fresh('b2')];
    const { picks, split } = chooseWithTargets(
      session([fresh('a1'), fresh('a2'), fresh('b1'), fresh('b2'), shared, ...mains(30)], [
        target('later', 'homework', 6, later),
        target('sooner', 'exam', 4, sooner),
      ]),
    );
    // Phase 55 (spec D4, D5): the sooner target's five slots hold one ladder; the later target's,
    // with the one passed on, one more; the two it leaves stay off the main path.
    expect(picks).toHaveLength(2);
    expect(count(picks, (pick) => pick.glossId === 'shared')).toBe(1);
    expect(split.map(({ targetId, slots, picked, wordCount }) => ({ targetId, slots, picked, wordCount }))).toEqual([
      { targetId: 'sooner', slots: 5, picked: 1, wordCount: 3 },
      { targetId: 'later', slots: 5, picked: 1, wordCount: 3 },
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

  it('passes the speaking pick on: a target of words never met or known aloud cannot make it, so the main path does', () => {
    // Phase 55 (spec D5): a target of words never met asks for every slot and the main path gets
    // none it leaves, so five words ready aloud bring the homework's wish to five, the main path's
    // share to five. The homework's five hold one ladder and one ready word, neither a speaking pick.
    const homework = [...unmet(2), ...range(5, (i) => readyAloud(`r${i}`))];
    const main = range(10, (i) => heard(`m${i}`));
    const { picks, split } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)], { speaking: true }));
    expect(split[0]).toMatchObject({ slots: 5, readyCount: 5 });
    expect(of(picks, homework).map((pick) => pick.cls)).toEqual(['NEW', 'NOT_DUE']);
    const spoken = picks.filter((pick) => pick.cls === 'SPEAK');
    expect(spoken).toHaveLength(1);
    expect(idsOf(main)).toContain(spoken[0].glossId);
  });

  it('makes one speaking pick a session: the first pool that can, and no pool after it', () => {
    // Phase 55 (spec D5): three words ready aloud bring the homework's wish to seven, so the main
    // path has three slots of its own, and words it could make the pick from.
    const homework = [...range(4, (i) => ({ id: `t${i}`, memory: { [WR]: 0.95 } })), ...range(3, (i) => readyAloud(`r${i}`))];
    const main = range(10, (i) => heard(`m${i}`));
    const { picks } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)], { speaking: true }));
    expect(of(picks, main)).toHaveLength(3);
    const spoken = picks.filter((pick) => pick.cls === 'SPEAK');
    expect(spoken).toHaveLength(1);
    expect(idsOf(homework)).toContain(spoken[0].glossId);
  });

  it('never asks a target word and a main word of one family, or of one key, in one session', () => {
    // Phase 55 (spec D5): a ready word brings the homework's wish to eight, its two ladders, so the
    // main path has two slots of its own.
    const homework = [...unmet(2), ready('r0')];
    // The main path's two neediest words: one of t0's family, one of t1's key.
    const main = [known('kin', { [WR]: 0.3 }), { ...known('twin', { [WR]: 0.35 }), key: 'KEY-t1 ' }, ...mains(12)];
    const families = { familyOf: new Map([['t0', 1], ['kin', 1]]), waiting: new Set<string>(), newMeanings: new Set<string>() };
    const { picks } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)], { families }));
    expect(picks).toHaveLength(4);
    expect(ids(picks)).toEqual(expect.arrayContaining(['t0', 't1']));
    expect(ids(picks)).not.toContain('kin');
    expect(ids(picks)).not.toContain('twin');
  });

  it('keeps a family for the return that claimed it, whichever pool holds the return', () => {
    // Phase 55 (spec D5): a ready word brings the homework's wish to eight, so the main path has
    // two slots of its own.
    const homework = [...unmet(2), ready('r0')];
    const main = [{ id: 'ret', memory: { [WR]: 1 } }, ...mains(12)];
    const families = { familyOf: new Map([['t0', 1], ['ret', 1]]), waiting: new Set<string>(), newMeanings: new Set<string>() };
    const { picks } = chooseWithTargets(
      session([...homework, ...main], [target('hw', 'homework', 5, homework)], { steps: [step('ret', WR)], families }),
    );
    expect(ids(picks)).toContain('ret');
    expect(ids(picks)).not.toContain('t0');
  });

  it("asks a target word that waits on its family's practised meaning, on an exam's eve too, never beside it (final review I1)", () => {
    // `kin`, saved and practised, is its family's current meaning, and due; `t`, the list's
    // word, never met, waits behind it (phase 39).
    const t = fresh('t');
    // Phase 55 (spec D5): three words ready beside t, so that four days out the exam asks for
    // seven slots and the main path has three of its own to ask kin in.
    const exam = [t, ...range(3, (i) => ready(`r${i}`))];
    const words = [...exam, known('kin', { [WR]: 0.3 }), ...mains(12)];
    const families = { familyOf: new Map([['t', 1], ['kin', 1]]), waiting: new Set(['t']), newMeanings: new Set<string>() };
    for (const daysLeft of [4, 2, 1]) {
      const { picks, split } = chooseWithTargets(session(words, [target('exam', 'exam', daysLeft, exam)], { families }));
      // t is a ladder, four slots, and the ready words three. In the run-up the exam asks for every
      // slot, and the three it leaves stay off the main path.
      const main = daysLeft === 4 ? 3 : 0;
      expect({ daysLeft, picks: picks.length, t: ids(picks).includes('t'), kin: ids(picks).includes('kin') }).toEqual({
        daysLeft,
        picks: 1 + 3 + main,
        t: true,
        kin: false,
      });
      expect(split[0]).toMatchObject({ slots: SESSION_LENGTH - main, picked: 4, reason: daysLeft === 1 ? 'exclusive' : expect.any(String) });
    }
    // On no target, the word waits again: the main path asks the meaning it waits on.
    const { picks } = chooseWithTargets(session(words, [], { families }));
    expect(ids(picks)).toContain('kin');
    expect(ids(picks)).not.toContain('t');
  });

  it('lets a target keep its pace past the daily cap, while the main path meets no new word', () => {
    const others = [...range(5, (i) => fresh(`n${i}`)), ...mains(30)];
    const exam = unmet(20);
    const { picks, split } = chooseWithTargets(session([...exam, ...others], [target('exam', 'exam', 2, exam)], { newToday: DAY_NEW_CAP }));
    // Phase 54 (spec D4): its pace past the cap, but the session's ceiling of ladders at most.
    expect(of(picks, exam).filter((pick) => pick.cls === 'NEW')).toHaveLength(NEW_PER_SESSION);
    expect(split[0]).toMatchObject({ reason: 'run_up', slots: 10, picked: NEW_PER_SESSION });
    // A list that leaves the main path a share: it fills it with no new word of its own. Phase 55
    // (spec D5): what a target leaves no longer reaches the main path, so a word ready brings a
    // homework's wish to eight, and two days out its two new words are both owed: the first takes
    // the cap's last new word, the second goes past it. The main path's two slots fit no ladder,
    // but they fit `meaning`, a family's new meaning, one slot (phase 54): the cap holds it back.
    const few = unmet(2);
    const homework = [...few, ready('r0')];
    const short = chooseWithTargets(
      session([...homework, fresh('meaning'), ...others], [target('hw', 'homework', 2, homework)], {
        newToday: DAY_NEW_CAP - 1,
        families: { ...NO_FAMILIES, newMeanings: new Set(['meaning']) },
      }),
    );
    expect(short.split[0]).toMatchObject({ slots: 8, picked: 2 });
    expect(short.picks).toHaveLength(few.length + SESSION_LENGTH - few.length * LADDER_SLOTS);
    expect(ids(short.picks.filter((pick) => pick.cls === 'NEW')).sort()).toEqual(idsOf(few).sort());
  });

  it("counts a target's new words toward the daily cap: what the target spends, the main path does not get", () => {
    // Phase 55 (spec D5): forty words ready bring the exam's wish to six, so the main path has four
    // slots of its own, room for a ladder.
    const exam = [...unmet(10), ...range(40, (i) => ready(`r${i}`))];
    expect(owedNew(10, 0, 20)).toBe(1);
    const others = [...range(5, (i) => fresh(`n${i}`)), ...mains(30)];
    const { picks, split } = chooseWithTargets(session([...exam, ...others], [target('exam', 'exam', 20, exam)], { newToday: DAY_NEW_CAP - 1 }));
    // The exam's one owed ladder, four slots, and two ready words. The ladder spends the cap's last
    // new word, so the main path's four slots, which could hold a ladder, hold four words it knows.
    expect(split[0]).toMatchObject({ slots: 6, picked: 3 });
    expect(picks).toHaveLength(3 + SESSION_LENGTH - 6);
    expect(of(picks, mains(30))).toHaveLength(SESSION_LENGTH - 6);
    const introduced = picks.filter((pick) => pick.cls === 'NEW');
    expect(introduced).toHaveLength(1);
    expect(of(introduced, exam)).toHaveLength(1);
  });

  it("keeps the main path's own new-word floor after a target's new words, below the session's ceiling", () => {
    const backlog = range(12, (i) => known(`d${i}`, { [[WR, WP, SP, SR][i % 4]]: 0.5 }));
    const news = range(5, (i) => fresh(`n${i}`));
    // Phase 55 (spec D4, D5): a homework of one new word and three ready asks for five slots, its
    // ladder's four and a ready word; the main path's floor, the session's second ladder, takes
    // four of its five, and one due word the last.
    const one = unmet(1);
    const homework = [...one, ...range(3, (i) => ready(`r${i}`))];
    const { picks } = chooseWithTargets(session([...homework, ...backlog, ...news], [target('hw', 'homework', 5, homework)]));
    expect(picks.map((pick) => pick.cls)).toEqual(['NEW', 'NOT_DUE', 'NEW', 'DUE']);
    expect(of(picks, one)).toHaveLength(1);
    expect(of(picks, news)).toHaveLength(NEW_FLOOR);
    // A homework of two new words asks for every slot, and its two ladders spend the session's
    // ceiling: the main path has no slot for its floor, and the two left stay off it.
    const two = unmet(2);
    const ceiling = chooseWithTargets(session([...two, ...backlog, ...news], [target('hw', 'homework', 5, two)]));
    expect(ceiling.picks.map((pick) => pick.cls)).toEqual(['NEW', 'NEW']);
    expect(of(ceiling.picks, news)).toHaveLength(0);
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
    // Phase 55 (spec D4): two ladders, the session's ceiling below the pace of three, take eight
    // slots; two words met today the rest.
    expect(picks).toHaveLength(4);
    expect(count(picks, (pick) => pick.cls === 'NEW')).toBe(NEW_PER_SESSION);
  });

  it("introduces the new words a target owes before its returns: an exam in 3 days, the daily cap already spent", () => {
    /** A session after the list's first `k` words were met earlier today, each owing its return. */
    const classesAfter = (list: Word[], k: number) => {
      const met = list.slice(0, k).map((word) => ({ ...word, memory: { [WR]: 1 } }));
      const { picks } = chooseWithTargets(
        session(
          [...met, ...list.slice(k), ...mains(10)],
          [target('exam', 'exam', 3, list)],
          { newToday: DAY_NEW_CAP + k, steps: met.map((word, i) => step(word.id, WR, i)) },
          { introducedToday: new Set(idsOf(met)) },
        ),
      );
      return picks.map((pick) => pick.cls);
    };
    const all = (cls: ChosenPick['cls'], n = SESSION_LENGTH) => Array<ChosenPick['cls']>(n).fill(cls);

    // Two days to meet 40 words in: 20 today. Phase 55 (spec D4, D5): a session meets two, its
    // ceiling, in eight slots, ahead of the returns the sessions before it opened, which take the
    // other two; with none opened, the two slots left stay off the main path. Once the 20 are met,
    // the returns, and no new word past the cap.
    expect(owedNew(40, 0, 3)).toBe(20);
    const forty = unmet(40);
    const rest = SESSION_LENGTH - NEW_PER_SESSION * LADDER_SLOTS;
    expect(classesAfter(forty, 0)).toEqual(all('NEW', NEW_PER_SESSION));
    expect(classesAfter(forty, 10)).toEqual([...all('NEW', NEW_PER_SESSION), ...all('STEP', rest)]);
    expect(classesAfter(forty, 20)).toEqual(all('STEP'));
    // 30 words owe 15: with ten met, five still owed, two of them in this session.
    expect(owedNew(30, 0, 3)).toBe(15);
    expect(classesAfter(unmet(30), 10)).toEqual([...all('NEW', NEW_PER_SESSION), ...all('STEP', rest)]);
  });

  it("keeps a target's pace across both passes: past the daily cap, no more new words than it owes", () => {
    // Every saved word is the homework's, so the main path leaves its slots unpicked.
    expect(owedNew(20, 0, 11)).toBe(2);
    const homework = unmet(20);
    const { picks, split } = chooseWithTargets(session(homework, [target('hw', 'homework', 11, homework)], { newToday: DAY_NEW_CAP }));
    expect(picks.map((pick) => pick.cls)).toEqual(['NEW', 'NEW']);
    expect(split[0]).toMatchObject({ slots: 10, picked: 2 });
  });

  it('leaves no session empty while a word can be asked: a random input the first version left empty', () => {
    // g1 is new and only the exam's; the cap is spent; the exam owes no new word today, since
    // g0 was met today; and g0 waits (phase 39). The first version asked nothing. Then g1 came
    // past the cap. Since final review I1 a target's word is asked though it waits, so x0, the
    // first pool to list g0, asks it. New words past the cap from a listing pool are shown by
    // choosePools' "goes past the daily cap only for a session still empty".
    const words = [{ id: 'g0', memory: { [WR]: 0.95, [SP]: 0.5, [SR]: 0.1, [SK]: 0.1 } }, fresh('g1', { key: 'run' })];
    const families = { familyOf: new Map<string, number | string>([['g0', 'f2'], ['g1', 0]]), waiting: new Set(['g0']), newMeanings: new Set<string>() };
    const targets = [target('x0', 'homework', 13, [words[0]]), target('x1', 'homework', 9, []), target('x2', 'exam', 14, words)];
    expect(owedNew(1, 1, 14)).toBe(0);
    const { picks, split } = chooseWithTargets(
      session(words, targets, { newToday: DAY_NEW_CAP + 3, listening: false, speaking: true, families }, { introducedToday: new Set(['g0']) }),
    );
    expect(picks).toEqual([{ glossId: 'g0', dimension: SK, rung: 1, level: 1, r: 0.1, cls: 'DUE', ladder: false }]);
    expect(split.map(({ targetId, picked }) => ({ targetId, picked }))).toEqual([
      { targetId: 'x1', picked: 0 },
      { targetId: 'x0', picked: 1 },
      { targetId: 'x2', picked: 0 },
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
    const hard = range(HARD_CAP, (i) => known(`t${i}`, { [WR]: 0.19 }));
    // Phase 55 (spec D5): as many words ready bring the homework's wish to seven, so the main
    // path has three slots of its own.
    const homework = [...hard, ...range(HARD_CAP, (i) => ready(`r${i}`))];
    const main = [...range(HARD_CAP, (i) => known(`h${i}`, { [WP]: 0.19 })), ...range(SESSION_LENGTH, (i) => known(`m${i}`, { [SP]: 0.92 }))];
    const { picks, split } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)]));
    expect(split[0]).toMatchObject({ slots: 7 });
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, hard)).toHaveLength(HARD_CAP);
    expect(count(picks, (pick) => expectedSuccess(pick.r, pick.rung === 1, pick.rung) < 0.6)).toBe(HARD_CAP);
  });

  it('counts the per-skill limit over the whole session', () => {
    // Met in writing only: each expands into listening.
    const writing = (id: string): Word => ({ id, memory: { [WR]: 0.95, [WP]: 0.95 } });
    const written = range(PER_DIMENSION_CAP, (i) => writing(`t${i}`));
    // Phase 55 (spec D5): as many words ready bring the homework's wish to seven, so the main
    // path has three slots of its own.
    const homework = [...written, ...range(PER_DIMENSION_CAP, (i) => ready(`r${i}`))];
    const main = [...range(PER_DIMENSION_CAP, (i) => writing(`s${i}`)), ...range(SESSION_LENGTH, (i) => known(`m${i}`, { [SP]: 0.92 }))];
    const { picks, split } = chooseWithTargets(session([...homework, ...main], [target('hw', 'homework', 5, homework)]));
    expect(split[0]).toMatchObject({ slots: 7 });
    expect(picks).toHaveLength(SESSION_LENGTH);
    expect(of(picks, written)).toHaveLength(PER_DIMENSION_CAP);
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
    // Phase 55 (spec D4, D5): a's one ladder leaves one of its five slots, too few for a second;
    // with it, b's one-slot pool, a later listing pool's, can hold the session's speaking pick,
    // ahead of the main path.
    const b = range(3, (i) => ({ id: `b${i}`, memory: { [WR]: 0.95 } }));
    const words = [fresh('a1'), fresh('a2'), ...b, ...range(6, (i) => heard(`m${i}`))];
    const [first, second, main] = choosePools(input(words, { speaking: true }), [
      { glossIds: new Set(['a1', 'a2']), slots: 5, owedNew: 0 },
      { glossIds: new Set(idsOf(b)), slots: 1, owedNew: 0 },
      { glossIds: null, slots: 4, owedNew: 0 },
    ]);
    expect(ids(first)).toEqual(['a2']);
    expect(second.map((pick) => pick.cls)).toEqual(['SPEAK', 'EXPAND']);
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
    // d is due, but r's return claims their family. Phase 55 (spec D4): counted as due, d and e
    // leave room for one new word before r; left out of the lists, d would leave room for two.
    // The second comes after the due word, in the four slots left.
    const words = [{ id: 'r', memory: { [WR]: 1 } }, known('d', { [WP]: 0.4 }), known('e', { [WP]: 0.4 }), ...range(3, (i) => fresh(`f${i}`))];
    const families = { familyOf: new Map([['r', 1], ['d', 1]]), waiting: new Set<string>(), newMeanings: new Set<string>() };
    const picks = chooseWords(input(words, { steps: [step('r', WR)], families }));
    expect(picks.map((pick) => [pick.glossId, pick.cls])).toEqual([
      ['f2', 'NEW'],
      ['r', 'STEP'],
      ['e', 'DUE'],
      ['f1', 'NEW'],
    ]);
  });

  it('with one pool, adds nothing in the second pass: a pool gives no more picks than the groups it first held', () => {
    // A key bridges a's family to c, so the three count as one group (phase 39): the first
    // pass stops at a, and c, free as it is, waits for another session.
    const words = [{ id: 'a', memory: { [WR]: 1 } }, { ...known('b', { [WP]: 0.4 }), key: 'k2' }, { ...known('c'), key: 'k2' }];
    const families = { familyOf: new Map([['a', 1], ['b', 1]]), waiting: new Set<string>(), newMeanings: new Set<string>() };
    expect(ids(chooseWords(input(words, { steps: [step('a', WR)], families })))).toEqual(['a']);
  });

  it("leaves a word an earlier pool took out of a later pool's lists: it holds back none of that pool's new words", () => {
    const later = [known('x', { [WR]: 0.3 }), ...range(3, (i) => fresh(`n${i}`)), ...range(5, (i) => ({ id: `e${i}`, memory: { [WR]: 0.95 } }))];
    // The second pool fills its eight slots, so no second pass comes back to it.
    const [first, second] = choosePools(input(later), [
      { glossIds: new Set(['x']), slots: 1, owedNew: 0 },
      { glossIds: new Set(idsOf(later)), slots: 8, owedNew: 0 },
      { glossIds: null, slots: 0, owedNew: 0 },
    ]);
    expect(ids(first)).toEqual(['x']);
    // Phase 55 (spec D4): eight slots, two ladders. Still counted as a due word to ask, x would
    // shrink the second pool's reserve to one ladder, and expansions would take the last four slots.
    expect(second.map((pick) => pick.cls)).toEqual(['NEW', 'NEW']);
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
    // Nothing picked in either pass: new words past the cap, each pool's in turn, to the
    // session's ceiling of ladders.
    expect(choosePools(input(news, capSpent), pools('n0')).map(ids)).toEqual([['n0'], ['n2']]);
    // Phase 55 (spec D5): unchanged, every slot left offered to every pool, a listing pool's
    // included: the main path, with no slot of its own, takes four of the six the first leaves.
    expect(choosePools(input(news, capSpent), pools('n0', SESSION_LENGTH)).map(ids)).toEqual([['n0'], ['n2']]);
  });
});

describe('splitChanged (spec D12)', () => {
  const row = (targetId: string, slots: number, over: Partial<TargetSplit> = {}): TargetSplit => ({
    targetId,
    wish: 10,
    slots,
    picked: slots,
    reason: 'not_ready',
    daysLeft: 5,
    readyCount: 0,
    wordCount: 8,
    ...over,
  });

  it('reads only the slots each target is given: a day nearer, more words ready, the same share', () => {
    const recorded = [row('a', 5), row('b', 5)];
    const today = [row('b', 5, { daysLeft: 3, readyCount: 4, picked: 2 }), row('a', 5, { wish: 7, reason: 'run_up', daysLeft: 2 })];
    expect(splitChanged(recorded, today)).toBe(false);
  });

  it('is unchanged with no target on either side', () => {
    expect(splitChanged([], [])).toBe(false);
  });

  it.each([
    ['a target is given other slots', [row('a', 10), row('b', 0)]],
    ['a target is no longer served', [row('a', 5)]],
    ['a target is served that was not', [row('a', 5), row('b', 5), row('c', 0)]],
    ['another target takes the place of one', [row('a', 5), row('c', 5)]],
  ])('changes when %s', (_, today) => {
    expect(splitChanged([row('a', 5), row('b', 5)], today)).toBe(true);
  });
});

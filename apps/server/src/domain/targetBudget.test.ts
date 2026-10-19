import { describe, expect, it } from '@jest/globals';

import type { Dimension, GradableAnswer } from '@lang-tutor/core/domain';

import { LADDER_SLOTS } from './chooseConstants';
import { DEFAULT_MISS_RATE, PLAY_SESSIONS_MAX, missEveryOf, missRateOf, playBudget, playTodayForward, type PlayInput } from './targetBudget';
import type { TargetWordInput } from './targetDay';
import type { TargetPickInput } from './targetPicker';
import type { TargetSkillRow } from './targetSkills';

// Phase 65 (spec D7.1, ruling T5-a). Today's sessions, as the target picker itself would make them
// for the day's owed work, every answer right or missing on the learner's rhythm.

const WR: Dimension = 'written_receptive';
const WP: Dimension = 'written_productive';
const SP: Dimension = 'spelling';
const WRITTEN: Dimension[] = [WR, WP, SP];

const TODAY = '2026-10-19';
/** Three days left: the cap is 10 half-points. */
const IN_THREE = '2026-10-22';
const TOMORROW = '2026-10-20';

const pick: Omit<TargetPickInput, 'day' | 'mode' | 'inFlight'> = {
  levels: new Map(),
  known: new Set(),
  newMeanings: new Set(),
  keys: new Map(),
};

const word = (glossId: string, startedOn: string | null, live: Dimension[] = WRITTEN): TargetWordInput => ({
  glossId,
  addedOn: '2026-10-10',
  startedOn,
  live,
});

const skill = (glossId: string, dimension: Dimension, halves: number): TargetSkillRow => ({
  targetId: 't1',
  glossId,
  dimension,
  halves,
  sessionId: null,
  day: '2026-10-16',
});

const day = (over: Partial<PlayInput>): PlayInput => ({
  pick,
  today: TODAY,
  createdOn: '2026-10-10',
  dueOn: IN_THREE,
  words: [],
  skills: [],
  rightToday: new Set(),
  answeredToday: false,
  ...over,
});
const play = (over: Partial<PlayInput>, missRate = 0) => playTodayForward({ ...day(over), missRate });

/** Five new words made today and due tomorrow, their written skills live: every word is planned
 *  today, and the eve's cap is a skill's full 20 half-points. */
const FIVE = day({ createdOn: TODAY, dueOn: TOMORROW, words: ['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => word(id, null)) });

describe('playTodayForward (spec D7.1)', () => {
  it('plays nothing when nothing is owed', () => {
    expect(play({})).toEqual({ sessions: 0, cards: 0 });
    // A word started days ago, every skill at the cap: done for today.
    expect(play({ words: [word('g1', '2026-10-15', [WP])], skills: [skill('g1', WP, 10)] })).toEqual({ sessions: 0, cards: 0 });
  });

  it('moves a skill once a session: 8 half-points below the cap at +4 a recall are two sessions', () => {
    // Started days ago (no next-day check), its one live skill at 2 of the cap's 10: a typed
    // translation a session, +4 each, one change per skill per session.
    expect(play({ words: [word('g1', '2026-10-15', [WP])], skills: [skill('g1', WP, 2)] })).toEqual({ sessions: 2, cards: 2 });
  });

  it("answers a word's next-day checks right, so they are owed once", () => {
    // Started yesterday, every skill at the cap: its checks alone are owed, and one typed
    // translation answers all three.
    const skills = WRITTEN.map((dimension) => skill('g1', dimension, 10));
    expect(play({ words: [word('g1', '2026-10-18')], skills })).toEqual({ sessions: 1, cards: 1 });
    // A check answered right today already is not owed.
    const rightToday = new Set(WRITTEN.map((dimension) => `g1|${dimension}`));
    expect(play({ words: [word('g1', '2026-10-18')], skills, rightToday, answeredToday: true })).toEqual({ sessions: 0, cards: 0 });
  });

  it('starts new words two ladders a session, over several sessions', () => {
    // With no live skill a started word owes nothing more: the play is its starts alone, two
    // ladders a session (NEW_PER_SESSION), so every word is started by its end.
    const starts = FIVE.words.map((one) => ({ ...one, live: [] }));
    expect(play({ ...FIVE, words: starts })).toEqual({ sessions: 3, cards: 5 * LADDER_SLOTS });
    // With their written skills, each started word then climbs to the eve's cap: two ladders and
    // two skills of earlier words in the second session, then six more of typed and choice cards.
    expect(play(FIVE)).toEqual({ sessions: 9, cards: 55 });
  });
});

// Ruling T5-a. The play misses on a fixed rhythm at the learner's rate: every missEveryOf-th graded
// pick across the play is an Again, which costs its skill 4 half-points, so the picker asks it
// again in a later session of the play.
describe('playTodayForward at a miss rate (ruling T5-a)', () => {
  it('misses every round(1 / rate)-th graded pick, every second at most, and never at 0', () => {
    expect([0.1, 0.2, 0.25, 1 / 3, 0.5, 1].map(missEveryOf)).toEqual([10, 5, 4, 3, 2, 2]);
    expect(missEveryOf(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('plays more sessions at 0.2 than at 0 for the same day: the misses are asked again', () => {
    expect(play(FIVE, 0.2).sessions).toBeGreaterThan(play(FIVE).sessions);
    expect(play(FIVE, 0.2)).toEqual({ sessions: 16, cards: 73 });
    expect(play(FIVE, 0.1)).toEqual({ sessions: 12, cards: 63 });
  });

  it('never misses a ladder: a day of starts alone plays the same at any rate', () => {
    const starts = FIVE.words.map((one) => ({ ...one, live: [] }));
    expect(play({ ...FIVE, words: starts }, 1)).toEqual(play({ ...FIVE, words: starts }));
  });

  it('misses nothing on a day of fewer graded picks than its rhythm', () => {
    // Two typed translations, one a session: at 0.1 the tenth pick would be the first missed.
    const one = { words: [word('g1', '2026-10-15', [WP])], skills: [skill('g1', WP, 2)] };
    expect(play(one, DEFAULT_MISS_RATE)).toEqual({ sessions: 2, cards: 2 });
  });

  it(`stops at ${PLAY_SESSIONS_MAX} sessions when the misses keep undoing a skill's gains`, () => {
    // One skill asked once a session, every second pick missed: 2 → 6 → 2 → 6, never the cap.
    const one = { words: [word('g1', '2026-10-15', [WP])], skills: [skill('g1', WP, 2)] };
    expect(play(one, 0.5)).toEqual({ sessions: PLAY_SESSIONS_MAX, cards: PLAY_SESSIONS_MAX });
  });
});

describe('playBudget (spec D7.1, ruling T5-a)', () => {
  it("is the play at the learner's rate, its room the sessions its misses add, its cards the missing play's", () => {
    expect(playBudget(FIVE, 0.2)).toEqual({ sessions: 16, cards: 73, missRoom: 16 - 9 });
  });

  it('is the play all right at 0, with no room', () => {
    expect(playBudget(FIVE, 0)).toEqual({ sessions: 9, cards: 55, missRoom: 0 });
    expect(playBudget(day({}), DEFAULT_MISS_RATE)).toEqual({ sessions: 0, cards: 0, missRoom: 0 });
  });
});

describe('missRateOf (spec D7.1)', () => {
  const right: GradableAnswer = { type: 'typed_translation', verdict: 'exact' };
  const miss: GradableAnswer = { type: 'multiple_choice', correct: false };
  const intro: GradableAnswer = { type: 'letter_tiles', verdict: 'wrong', intro: true };
  const of = (rights: number, misses: number, extra: GradableAnswer[] = []) => [
    ...Array.from({ length: rights }, () => right),
    ...Array.from({ length: misses }, () => miss),
    ...extra,
  ];

  it('is the default below 20 graded answers', () => {
    expect(missRateOf(of(10, 9))).toBe(DEFAULT_MISS_RATE);
    expect(DEFAULT_MISS_RATE).toBe(0.1);
    // An intro card grades nothing: 19 graded answers and an intro are still too few.
    expect(missRateOf(of(10, 9, [intro]))).toBe(DEFAULT_MISS_RATE);
  });

  it('is the share of graded answers with an Again piece', () => {
    expect(missRateOf(of(41, 4))).toBe(4 / 45);
    // A near miss of a typed translation is spelling Again: a miss.
    expect(missRateOf(of(19, 0, [{ type: 'typed_translation', verdict: 'near_miss' }]))).toBe(1 / 20);
    // Intro answers count in neither part.
    expect(missRateOf(of(41, 4, [intro, intro]))).toBe(4 / 45);
  });
});

import { describe, expect, it } from '@jest/globals';

import type { Dimension, GradableAnswer } from '@lang-tutor/core/domain';

import { LADDER_SLOTS } from './chooseConstants';
import { DEFAULT_MISS_RATE, MISS_RATE_CAP, PLAY_SESSIONS_MAX, budgetSessions, missRateOf, pastBudget, playTodayForward } from './targetBudget';
import type { TargetWordInput } from './targetDay';
import type { TargetPickInput } from './targetPicker';
import type { TargetSkillRow } from './targetSkills';

// Phase 65 (spec D7.1, ruling T5-b). Today's sessions, as the target picker itself would make them
// for the day's owed work with every answer right, stretched for the learner's misses.

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

const play = (over: Partial<Parameters<typeof playTodayForward>[0]>) =>
  playTodayForward({
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
    const fresh = ['g1', 'g2', 'g3', 'g4', 'g5'];
    // Made today, due tomorrow: every word is planned today.
    const due = { createdOn: TODAY, dueOn: TOMORROW };
    // With no live skill a started word owes nothing more: the play is its starts alone, two
    // ladders a session (NEW_PER_SESSION), so every word is started by its end.
    expect(play({ ...due, words: fresh.map((id) => word(id, null, [])) })).toEqual({ sessions: 3, cards: 5 * LADDER_SLOTS });
    // With their written skills, each started word then climbs to the eve's cap of 20: its
    // ladder's practice cards (ruling T9-a) take each skill to 4, then four sessions of typed
    // translations (+4 each) the rest of the way. The last word starts in the third session, so its
    // climb ends in the seventh. (A ladder that graded nothing made this 9 sessions, 55 cards.)
    expect(play({ ...due, words: fresh.map((id) => word(id, null)) })).toEqual({ sessions: 7, cards: 40 });
  });

  it("answers a ladder's practice cards right: a fresh word's ladder session alone does its written work (ruling T9-a)", () => {
    // Due in 20 days, made nine days ago: three intro days reached, so every word is planned today,
    // and the cap is 4 half-points. The ladder's typed translation is a recall of all three written
    // skills (+4 each, to the cap); its intro stage grades nothing.
    const far = { createdOn: '2026-10-10', dueOn: '2026-11-08' };
    expect(play({ ...far, words: [word('g1', null)] })).toEqual({ sessions: 1, cards: LADDER_SLOTS });
    // Two fresh words: two ladders, one session.
    expect(play({ ...far, words: [word('g1', null), word('g2', null)] })).toEqual({ sessions: 1, cards: 2 * LADDER_SLOTS });
  });

  it(`cuts a very large day short at ${PLAY_SESSIONS_MAX} sessions`, () => {
    const due = { createdOn: TODAY, dueOn: TOMORROW };
    const fresh = (n: number) => Array.from({ length: n }, (_, i) => word(`g${String(i).padStart(2, '0')}`, null));
    // 36 fresh words due tomorrow play in 29 sessions; 40 would take more, and stop at the bound.
    expect(play({ ...due, words: fresh(36) }).sessions).toBe(29);
    expect(play({ ...due, words: fresh(40) }).sessions).toBe(PLAY_SESSIONS_MAX);
  });
});

// Ruling T5-b. A skill climbs +4 a right answer and drops −4 a miss, so at a miss share m it climbs
// 1 − 2m as fast: the play's sessions over 1 − 2m, the rate capped so the factor is 2 at most.
describe('budgetSessions (spec D7.1, ruling T5-b)', () => {
  const play = { sessions: 5, cards: 40 };

  it("stretches the all-right play by 1 / (1 − 2m), in whole sessions", () => {
    expect(budgetSessions(play, 0)).toBe(5);
    // 5 / 0.6 = 8.33: nine sessions.
    expect(budgetSessions(play, 0.2)).toBe(9);
    // 5 / 0.8 = 6.25 at the default rate: seven.
    expect(budgetSessions(play, DEFAULT_MISS_RATE)).toBe(7);
    expect(budgetSessions({ sessions: 0, cards: 0 }, DEFAULT_MISS_RATE)).toBe(0);
  });

  it(`caps the rate at ${MISS_RATE_CAP}: the play's sessions doubled at most`, () => {
    expect(MISS_RATE_CAP).toBe(0.25);
    expect(budgetSessions(play, 0.25)).toBe(10);
    expect(budgetSessions(play, 0.4)).toBe(10);
    expect(budgetSessions(play, 1)).toBe(10);
  });

  it('reads a whole number of sessions as that number, not one more', () => {
    // 21 / 0.7 is 30 sessions exactly, which floating point reads as 30.000000000000004.
    expect(budgetSessions({ sessions: 21, cards: 0 }, 0.15)).toBe(30);
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

describe('pastBudget (phase 65b D2)', () => {
  it('is false with no budget set yet', () => {
    expect(pastBudget({ budget: null, done: 7, inFlight: true })).toBe(false);
  });

  it('is false while sessions are left, counting the one in flight', () => {
    expect(pastBudget({ budget: 5, done: 3, inFlight: false })).toBe(false);
    expect(pastBudget({ budget: 5, done: 3, inFlight: true })).toBe(false);
  });

  it('is true once the sessions done, and the one in flight, meet the budget', () => {
    expect(pastBudget({ budget: 5, done: 4, inFlight: true })).toBe(true);
    expect(pastBudget({ budget: 5, done: 5, inFlight: false })).toBe(true);
    expect(pastBudget({ budget: 5, done: 6, inFlight: true })).toBe(true);
  });
});

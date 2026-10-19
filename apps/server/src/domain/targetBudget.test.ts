import { describe, expect, it } from '@jest/globals';

import type { Dimension, GradableAnswer } from '@lang-tutor/core/domain';

import { LADDER_SLOTS } from './chooseConstants';
import { DEFAULT_MISS_RATE, budgetSessions, missRateOf, playTodayForward } from './targetBudget';
import type { TargetWordInput } from './targetDay';
import type { TargetPickInput } from './targetPicker';
import type { TargetSkillRow } from './targetSkills';

// Phase 65 (spec D7.1). Today's sessions, as the target picker itself would make them for the
// day's owed work with every answer right, and the room for misses on top.

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
    // With their written skills, each started word then climbs to the cap: more sessions, and
    // the play still ends (under its 30) with every word started and at the cap.
    const written = play({ ...due, words: fresh.map((id) => word(id, null)) });
    expect(written.sessions).toBeGreaterThanOrEqual(3);
    expect(written.sessions).toBeLessThan(30);
    expect(written.cards).toBeGreaterThan(5 * LADDER_SLOTS);
  });
});

describe('budgetSessions (spec D7.1)', () => {
  it('adds whole sessions of room for misses to the play', () => {
    // 38 cards at 9% is 3.4 misses: one more session.
    expect(budgetSessions({ sessions: 4, cards: 38 }, 0.09)).toBe(5);
    expect(budgetSessions({ sessions: 4, cards: 38 }, 0)).toBe(4);
    expect(budgetSessions({ sessions: 0, cards: 0 }, DEFAULT_MISS_RATE)).toBe(0);
  });

  it('reads a whole number of sessions of misses as that number, not one more', () => {
    // 87 cards at 10 misses in 29 answers is 30 misses, 3 sessions exactly, which floating
    // point reads as 3.0000000000000004.
    expect(budgetSessions({ sessions: 9, cards: 87 }, 10 / 29)).toBe(12);
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

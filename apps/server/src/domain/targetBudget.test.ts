import { describe, expect, it } from '@jest/globals';

import type { Dimension } from '@lang-tutor/core/domain';

import { PLAY_SESSIONS_MAX, pastBudget, playTodayForward } from './targetBudget';
import type { SkillStart, TargetWordInput } from './targetDay';
import type { TargetPickInput } from './targetPicker';

// Phase 65 (spec D7.1), phase 67 (spec D5). Today's sessions, as the target picker itself makes
// them for the day's cards with every answer right. A miss adds no card, so the play is the day:
// nothing is stretched for misses.

const LIVE: Dimension[] = ['written_receptive', 'written_productive', 'spoken_receptive', 'spelling', 'spoken_productive'];
const HOMEWORK: Dimension[] = ['written_productive', 'spelling', 'spoken_productive'];

const TODAY = '2026-10-20';
const IN_TWO = '2026-10-22';
const TOMORROW = '2026-10-21';

const pick: Omit<TargetPickInput, 'day' | 'mode' | 'inFlight'> = {
  levels: new Map(),
  known: new Set(),
  newMeanings: new Set(),
  keys: new Map(),
};

const id = (i: number) => `g${String(i).padStart(3, '0')}`;
const words = (n: number, startedOn: string | null): TargetWordInput[] =>
  Array.from({ length: n }, (_, i) => ({ glossId: id(i), addedOn: '2026-10-17', startedOn, live: LIVE }));
const starts = (n: number, chance: number): SkillStart[] =>
  Array.from({ length: n }, (_, i) => HOMEWORK.map((dimension) => ({ glossId: id(i), dimension, chance, movedOn: null }))).flat();

const play = (over: Partial<Parameters<typeof playTodayForward>[0]>) =>
  playTodayForward({
    pick,
    today: TODAY,
    createdOn: '2026-10-17',
    dueOn: IN_TWO,
    kind: 'homework',
    words: [],
    starts: [],
    askedToday: [],
    answeredToday: false,
    ...over,
  });

describe('playTodayForward (phase 67, spec D5)', () => {
  it('plays nothing when every word is ready and it is not the eve', () => {
    expect(play({ words: words(15, '2026-10-17'), starts: starts(15, 0.98) })).toEqual({ sessions: 0, cards: 0 });
  });

  it("plays fifteen words below 90 at two days left as the picker makes them: two cards each, ten a session", () => {
    expect(play({ words: words(15, '2026-10-17'), starts: starts(15, 0.5) })).toEqual({ sessions: 3, cards: 30 });
  });

  it('counts the cards asked today: a word with both cards answered owes no session', () => {
    const askedToday = words(15, null).flatMap((word) => [
      { glossId: word.glossId, type: 'typed_translation' as const },
      { glossId: word.glossId, type: 'say_translation' as const },
    ]);
    expect(play({ words: words(15, '2026-10-17'), starts: starts(15, 0.5), askedToday, answeredToday: true })).toEqual({ sessions: 0, cards: 0 });
  });

  it("meets fifteen new words on the eve two ladders a session, then asks each its spelling and speaking", () => {
    const day = play({ createdOn: TODAY, dueOn: TOMORROW, words: words(15, null) });
    // A ladder is four slots and asks writing; its word's other two cards are one slot each. The
    // first session holds its two ladders alone (8 slots): no word is met yet to fill the rest.
    expect(day.cards).toBe(15 * 4 + 15 * 2);
    expect(day.sessions).toBe(10);
  });

  it(`cuts a very large day short at ${PLAY_SESSIONS_MAX} sessions`, () => {
    const day = play({ createdOn: TODAY, dueOn: TOMORROW, words: words(100, null) });
    expect(day.sessions).toBe(PLAY_SESSIONS_MAX);
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

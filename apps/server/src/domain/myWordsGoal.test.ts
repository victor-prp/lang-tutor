import { DEFAULT_MY_WORDS_GOAL, goalMinutes, goalOf, MAX_MY_WORDS_GOAL, storedGoal } from './myWordsGoal';

describe('goalOf (phase 73 D1)', () => {
  it('reads null as the default, 0 as off, a number as itself', () => {
    expect(DEFAULT_MY_WORDS_GOAL).toBe(3);
    expect(MAX_MY_WORDS_GOAL).toBe(20);
    expect(goalOf(null)).toBe(3);
    expect(goalOf(0)).toBeNull();
    expect(goalOf(7)).toBe(7);
  });
});

describe('storedGoal', () => {
  it('stores the default as null, off as 0, a number as itself', () => {
    expect(storedGoal(3)).toBeNull();
    expect(storedGoal(null)).toBe(0);
    expect(storedGoal(20)).toBe(20);
  });
});

describe('goalMinutes', () => {
  it('is the goal in sessions times a session of cards times their seconds, in minutes', () => {
    expect(goalMinutes(3)).toBe(15);
    expect(goalMinutes(1)).toBe(5);
  });
});

import { describe, expect, it } from '@jest/globals';

import { KnowledgeDimensionSchema } from '../api/schemas';
import { DIMENSIONS, LIVE_DIMENSIONS, MAX_LEVEL, MIN_LEVEL, badge } from './progress';

describe('badge', () => {
  it('is the level itself for one level', () => {
    expect(badge([3])).toBe(3);
  });

  it('rounds the mean to the nearest level', () => {
    expect(badge([1, 1, 2])).toBe(1);
    expect(badge([1, 2, 2])).toBe(2);
    expect(badge([2, 2, 3])).toBe(2);
    expect(badge([5, 1, 1])).toBe(2);
  });

  it('rounds a tie up', () => {
    expect(badge([1, 2])).toBe(2);
    expect(badge([4, 5])).toBe(5);
    expect(badge([1, 1, 2, 2])).toBe(2);
  });

  it('refuses no levels, which no sense can have', () => {
    expect(() => badge([])).toThrow();
  });
});

describe('dimensions', () => {
  it('are the five the wire publishes, in the same order', () => {
    expect(KnowledgeDimensionSchema.options).toEqual([...DIMENSIONS]);
  });

  it('has every live dimension among them', () => {
    expect(LIVE_DIMENSIONS.length).toBeGreaterThan(0);
    for (const dimension of LIVE_DIMENSIONS) expect(DIMENSIONS).toContain(dimension);
  });

  // All five are live since phase 25: each has a question type that feeds it
  // (the written three by phase 23's cards, spoken_receptive by listening,
  // spoken_productive by speaking).
  it('are live exactly when some question type feeds them', () => {
    expect([...LIVE_DIMENSIONS]).toEqual([
      'written_receptive',
      'written_productive',
      'spelling',
      'spoken_receptive',
      'spoken_productive',
    ]);
  });

  it('drops a badge by at most one level when spoken_productive goes live (phase 25 D11)', () => {
    expect(badge([4, 4, 4, 4])).toBe(4);
    expect(badge([4, 4, 4, 4, 1])).toBe(3);
    expect(badge([3, 3, 3, 3, 1])).toBe(3);
    expect(badge([5, 5, 5, 5, 1])).toBe(4);
  });

  it('runs levels from 1 to 5', () => {
    expect([MIN_LEVEL, MAX_LEVEL]).toEqual([1, 5]);
  });
});

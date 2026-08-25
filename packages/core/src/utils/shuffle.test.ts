import { describe, expect, it } from '@jest/globals';

import { seededRng } from './rng';
import { shuffle } from './shuffle';

describe('shuffle', () => {
  it('returns a new array and leaves the input untouched', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, seededRng(1));
    expect(out).not.toBe(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('preserves every element exactly once', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = shuffle(input, seededRng(2));
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('is deterministic for a given seed', () => {
    expect(shuffle([1, 2, 3, 4, 5, 6], seededRng(3))).toEqual(
      shuffle([1, 2, 3, 4, 5, 6], seededRng(3)),
    );
  });

  it('actually reorders rather than returning the input order', () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    expect(shuffle(input, seededRng(4))).not.toEqual(input);
  });

  it('handles empty and single-element arrays', () => {
    expect(shuffle([], seededRng(5))).toEqual([]);
    expect(shuffle(['only'], seededRng(6))).toEqual(['only']);
  });
});

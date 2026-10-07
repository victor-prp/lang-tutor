import { describe, expect, it } from '@jest/globals';

import { builtWord, placeTile, removeTile } from './tiles';

describe('letter tiles (spec D11)', () => {
  const tiles = ['s', 'a', 'c', 'x', 'a', 'q'];

  it('builds the word in the order the tiles were placed', () => {
    const placed = [2, 1, 0, 4].reduce(placeTile, [] as number[]);
    expect(builtWord(tiles, placed)).toBe('casa');
  });

  it('places a tile once, and returns a placed one to the pool', () => {
    expect(placeTile([2], 2)).toEqual([2]);
    expect(builtWord(tiles, removeTile([2, 1, 0], 1))).toBe('cs');
  });
});

import { describe, expect, it } from '@jest/globals';
import { tileLetters } from '@lang-tutor/core/domain';

import { builtWord, helpTile, isBuilt, tryTile } from './tiles';

describe('letter tiles (spec D11)', () => {
  it('builds the word in the order the tiles were placed', () => {
    expect(builtWord(['s', 'a', 'c', 'x', 'a', 'q'], [2, 1, 0, 4])).toBe('casa');
  });
});

// Phase 55 (spec D7). Each tile is checked as it is placed, by its letter.
describe('a tile checked as placed (phase 55 D7)', () => {
  const tiles = ['m', 'a', 'm', 'm', 'a', 'x', 'm'];
  const expected = tileLetters('mamma') ?? [];

  it('takes any tile of the next letter, duplicates and extras alike', () => {
    for (const tile of [0, 2, 3, 6]) expect(tryTile([], tile, tiles, expected)).toEqual({ placed: [tile], wrong: false });
    expect(tryTile([6], 1, tiles, expected)).toEqual({ placed: [6, 1], wrong: false });
    expect(tryTile([6], 4, tiles, expected)).toEqual({ placed: [6, 4], wrong: false });
  });

  it('refuses a wrong tile, and leaves what is placed as it was', () => {
    expect(tryTile([], 1, tiles, expected)).toEqual({ placed: [], wrong: true });
    expect(tryTile([0], 5, tiles, expected)).toEqual({ placed: [0], wrong: true });
    expect(tryTile([0], 2, tiles, expected)).toEqual({ placed: [0], wrong: true });
  });

  it('never places a tile twice, nor past the last letter', () => {
    expect(tryTile([0], 0, tiles, expected)).toEqual({ placed: [0], wrong: false });
    expect(tryTile([0, 1, 2, 3, 4], 6, tiles, expected)).toEqual({ placed: [0, 1, 2, 3, 4], wrong: false });
  });

  it('help gives the first unused tile of the next letter, skipping placed ones', () => {
    expect(helpTile([], tiles, expected)).toBe(0);
    expect(helpTile([0], tiles, expected)).toBe(1);
    expect(helpTile([0, 1], tiles, expected)).toBe(2);
    expect(helpTile([2, 1], tiles, expected)).toBe(0);
    expect(helpTile([0, 1, 2, 3], tiles, expected)).toBe(4);
    expect(helpTile([0, 1, 2, 3, 4], tiles, expected)).toBeNull();
  });

  it('is built once the last letter is placed', () => {
    expect(isBuilt([0, 1, 2, 3], expected)).toBe(false);
    expect(isBuilt([6, 4, 3, 2, 1], expected)).toBe(true);
    expect(builtWord(tiles, [6, 4, 3, 2, 1])).toBe('mamma');
    // A card with no letters to build never answers itself.
    expect(isBuilt([], [])).toBe(false);
  });

  it('reads an accented letter as its own letter', () => {
    const accented = ['c', 'e', 'a', 'f', 'è', 'f', 'o'];
    const caffe = tileLetters('caffè') ?? [];
    const before = [0, 2, 3, 5];
    expect(tryTile(before, 4, accented, caffe)).toEqual({ placed: [...before, 4], wrong: false });
    expect(tryTile(before, 1, accented, caffe)).toEqual({ placed: before, wrong: true });
    expect(helpTile(before, accented, caffe)).toBe(4);
  });
});

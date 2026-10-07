import { describe, expect, it } from '@jest/globals';

import { LANGUAGES } from './languages';
import { tileEligible, tilesFor } from './tiles';

// Not tests/support/testRng: ADR 0001 R3 greps domain/ for any parent-directory
// import, test files included. Same LCG.
function testRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

describe('tileEligible (spec D4, D11)', () => {
  it('takes one word of three to ten letters, and nothing else', () => {
    expect(tileEligible('casa')).toBe(true);
    expect(tileEligible('perché')).toBe(true);
    expect(tileEligible('молоко́')).toBe(true);
    expect(tileEligible('re')).toBe(false);
    expect(tileEligible('precipitevolissimevolmente')).toBe(false);
    expect(tileEligible('pick up')).toBe(false);
    expect(tileEligible("l'acqua")).toBe(false);
  });
});

describe('tilesFor (spec D11)', () => {
  it("is the word's letters, lowercased and unstressed, plus two from the alphabet", () => {
    const tiles = tilesFor('Молоко́', LANGUAGES.ru.alphabet, testRng(7));
    expect(tiles).toHaveLength(8);
    const rest = [...tiles];
    for (const letter of 'молоко') rest.splice(rest.indexOf(letter), 1);
    expect(rest).toHaveLength(2);
    for (const extra of rest) expect(LANGUAGES.ru.alphabet).toContain(extra);
  });

  it('is reproducible under a seeded rng', () => {
    expect(tilesFor('casa', LANGUAGES.it.alphabet, testRng(3))).toEqual(tilesFor('casa', LANGUAGES.it.alphabet, testRng(3)));
  });

  it('refuses a word that cannot be tiled', () => {
    expect(() => tilesFor('pick up', LANGUAGES.en.alphabet, testRng(3))).toThrow();
  });
});

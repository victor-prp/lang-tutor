import { describe, expect, it } from '@jest/globals';

import { stripStress, tileLetters } from './tiles';

describe('tileLetters (phase 55, spec D7)', () => {
  it("is the word's letters, lowercased, one per code point", () => {
    expect(tileLetters('casa')).toEqual(['c', 'a', 's', 'a']);
    expect(tileLetters('Città')).toEqual(['c', 'i', 't', 't', 'à']);
  });

  it('drops a Russian stress mark', () => {
    expect(tileLetters('го́род')).toEqual(['г', 'о', 'р', 'о', 'д']);
  });

  it('is null for a phrase, an elision, and a word too short or too long', () => {
    expect(tileLetters("l'acqua")).toBeNull();
    expect(tileLetters('fare colazione')).toBeNull();
    expect(tileLetters('ab')).toBeNull();
    expect(tileLetters('appuntamento')).toBeNull();
  });
});

describe('stripStress', () => {
  it('removes a combining acute after a Cyrillic letter, and only there', () => {
    expect(stripStress('молоко́')).toBe('молоко');
    expect(stripStress('café')).toBe('café');
  });
});

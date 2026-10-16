import { describe, expect, it } from '@jest/globals';

import { allRevealed, revealed } from './typedHelp';

// Phase 55 (spec D7). The typed card's help: one more character a press.
describe('typed help (phase 55 D7)', () => {
  it('reveals one letter a press, from the start', () => {
    expect(revealed('colazione', 0)).toBe('');
    expect(revealed('colazione', 1)).toBe('c');
    expect(revealed('colazione', 3)).toBe('col');
  });

  it('takes a space with the letter after it', () => {
    expect(revealed('fare colazione', 4)).toBe('fare');
    expect(revealed('fare colazione', 5)).toBe('fare c');
  });

  it('takes an apostrophe with the letter after it', () => {
    expect(revealed("l'acqua", 1)).toBe('l');
    expect(revealed("l'acqua", 2)).toBe("l'a");
    expect(revealed('l’acqua', 2)).toBe('l’a');
  });

  it('ends a form that ends in an apostrophe on its last press', () => {
    expect(revealed("un po'", 3)).toBe("un p");
    expect(revealed("un po'", 4)).toBe("un po'");
    expect(allRevealed("un po'", 4)).toBe(true);
  });

  it('keeps an accent with its letter', () => {
    expect(revealed('città', 5)).toBe('città');
    expect(revealed('città', 5)).toBe('città');
    expect(allRevealed('città', 5)).toBe(true);
  });

  it('is all revealed once every letter is', () => {
    expect(allRevealed('casa', 3)).toBe(false);
    expect(allRevealed('casa', 4)).toBe(true);
    expect(allRevealed('fare colazione', 12)).toBe(false);
    expect(allRevealed('fare colazione', 13)).toBe(true);
    expect(revealed('casa', 9)).toBe('casa');
  });
});

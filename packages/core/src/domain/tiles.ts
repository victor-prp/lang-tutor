/**
 * Phase 55 (spec D7). The letters of a word as letter tiles show them. They
 * live in core because the server builds the tiles from them and the app
 * judges a placed tile against them, and the two must read a word alike. Pure.
 */

export const TILE_MIN_LETTERS = 3;
export const TILE_MAX_LETTERS = 10;

/**
 * Removes U+0301 (combining acute) after a Cyrillic letter: `молоко́` and
 * `молоко` are one dictionary key. Stress is a reading aid, not spelling, and
 * native text never writes it. Deliberately narrow: a Latin accent (`café`,
 * decomposed) and Hebrew points are spelling and survive, and `ё` is a letter,
 * not a stress mark — `елка` is a misspelling of `ёлка`, handled by phase 13's
 * correction path rather than folded here.
 */
export function stripStress(text: string): string {
  return text.replace(/(\p{Script=Cyrillic})\u0301/gu, '$1');
}

/** Phase 24 (spec D11). The word's letters, lowercased and unstressed, one per
 *  code point after NFC; null when it is not one word of 3 to 10 letters. A
 *  phrase or an elision has no sensible tile set, and a long word is a wall of
 *  tiles. */
export function tileLetters(form: string): string[] | null {
  const letters = [...stripStress(form).normalize('NFC').toLowerCase()];
  if (letters.length < TILE_MIN_LETTERS || letters.length > TILE_MAX_LETTERS) return null;
  return letters.every((letter) => /\p{L}/u.test(letter)) ? letters : null;
}

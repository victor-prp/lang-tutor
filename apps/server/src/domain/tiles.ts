import { stripStress } from './languages';
import { pickSenses } from './session';

/**
 * Phase 24 (spec D11). Letter tiles: which words can be built from tiles, and
 * the tiles themselves. Pure; the rng is passed in (ADR 0001 R3).
 */

export const TILE_MIN_LETTERS = 3;
export const TILE_MAX_LETTERS = 10;
export const EXTRA_TILES = 2;

/** The word's letters, lowercased and unstressed, one per code point after
 *  NFC; null when it is not one word of 3 to 10 letters. A phrase or an
 *  elision has no sensible tile set, and a long word is a wall of tiles. */
function tileLetters(form: string): string[] | null {
  const letters = [...stripStress(form).normalize('NFC').toLowerCase()];
  if (letters.length < TILE_MIN_LETTERS || letters.length > TILE_MAX_LETTERS) return null;
  return letters.every((letter) => /\p{L}/u.test(letter)) ? letters : null;
}

export function tileEligible(form: string): boolean {
  return tileLetters(form) !== null;
}

/** The word's letters and two from `alphabet`, shuffled. */
export function tilesFor(form: string, alphabet: string, rng: () => number): string[] {
  const letters = tileLetters(form);
  if (!letters) throw new Error(`"${form}" cannot be built from tiles`);
  const pool = [...alphabet];
  const extras = Array.from({ length: EXTRA_TILES }, () => pool[Math.floor(rng() * pool.length)]);
  const all = [...letters, ...extras];
  // pickSenses keeping every entry is a uniform shuffle.
  return pickSenses(all, all.length, rng);
}

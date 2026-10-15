import { tileLetters } from '@lang-tutor/core/domain';

import { shuffle } from './session';

/**
 * Phase 24 (spec D11). Letter tiles: which words can be built from tiles, and
 * the tiles themselves. Pure; the rng is passed in (ADR 0001 R3).
 */

export { TILE_MAX_LETTERS, TILE_MIN_LETTERS } from '@lang-tutor/core/domain';
export const EXTRA_TILES = 2;

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
  return shuffle(all, rng);
}

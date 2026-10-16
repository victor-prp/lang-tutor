/** Phase 24 (spec D11). Letter tiles as pure state: `placed` holds tile indices
 *  in the order they were placed.
 *
 *  Phase 55 (spec D7). Each tile is checked as it is tapped, by its letter,
 *  against `expected`: core's `tileLetters(question.answer)`, the letters the
 *  server built the tiles from. So what is placed is always the word's right
 *  start, and a placed tile is never taken back. */
export function tryTile(
  placed: readonly number[],
  tile: number,
  tiles: readonly string[],
  expected: readonly string[],
): { placed: number[]; wrong: boolean } {
  if (placed.includes(tile) || isBuilt(placed, expected)) return { placed: [...placed], wrong: false };
  return tiles[tile] === expected[placed.length] ? { placed: [...placed, tile], wrong: false } : { placed: [...placed], wrong: true };
}

/** Phase 55 (spec D7). What help places: the first unused tile with the next
 *  letter, or null once the word is built. */
export function helpTile(placed: readonly number[], tiles: readonly string[], expected: readonly string[]): number | null {
  if (isBuilt(placed, expected)) return null;
  const next = tiles.findIndex((letter, tile) => letter === expected[placed.length] && !placed.includes(tile));
  return next === -1 ? null : next;
}

/** Phase 55 (spec D7). The last letter is placed: the card answers itself. A
 *  card with no letters to build never does. */
export function isBuilt(placed: readonly number[], expected: readonly string[]): boolean {
  return expected.length > 0 && placed.length >= expected.length;
}

export function builtWord(tiles: readonly string[], placed: readonly number[]): string {
  return placed.map((tile) => tiles[tile]).join('');
}

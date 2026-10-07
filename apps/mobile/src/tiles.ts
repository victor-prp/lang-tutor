/** Phase 24 (spec D11). Letter tiles as pure state: `placed` holds tile indices
 *  in the order they were tapped. */
export function placeTile(placed: readonly number[], tile: number): number[] {
  return placed.includes(tile) ? [...placed] : [...placed, tile];
}

export function removeTile(placed: readonly number[], slot: number): number[] {
  return placed.filter((_, index) => index !== slot);
}

export function builtWord(tiles: readonly string[], placed: readonly number[]): string {
  return placed.map((tile) => tiles[tile]).join('');
}

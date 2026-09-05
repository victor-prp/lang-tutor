// A deterministic rng for tests. packages/core's seededRng is deliberately
// unreachable — `utils` is absent from both core's index.ts and its exports map
// — and this phase does not change that.
export function testRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

import { describe, expect, it } from '@jest/globals';

import { keepCards, MIN_SESSION_CARDS, type CardUnit, type Refusal } from './keepCards';

// Not tests/support/testRng: ADR 0001 R3 greps domain/ for any parent-directory
// import, test files included. Same LCG.
function testRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

const CHECKER: Refusal = { stage: 'checker', reason: "the checker calls 4 of q10's 6 wrong options right, and 3 must be left" };
const VALIDATION: Refusal = { stage: 'validation', reason: 'q2 needs three non-empty wrong answers' };
const single = (index: number, refusal: Refusal | null = null): CardUnit => ({ indexes: [index], refusal });
const singles = (n: number, refused: Record<number, Refusal> = {}) => Array.from({ length: n }, (_, i) => single(i, refused[i] ?? null));
const fates = (units: CardUnit[], rng = testRng(1)) => keepCards(units, rng).map((c) => (c.fate === 'keep_refused' ? `${c.index}:${c.shownAs}` : `${c.index}:${c.fate}`));

describe('keepCards (phase 48, spec D3)', () => {
  it('keeps every card when none is refused', () => {
    expect(fates(singles(10))).toEqual(Array.from({ length: 10 }, (_, i) => `${i}:keep`));
  });

  it('drops a refused card when the rest reach the floor of six', () => {
    expect(MIN_SESSION_CARDS).toBe(6);
    const out = fates(singles(10, { 9: CHECKER, 3: VALIDATION }));
    expect(out.filter((f) => f.endsWith(':drop'))).toEqual(['3:drop', '9:drop']);
    expect(out.filter((f) => f.endsWith(':keep'))).toHaveLength(8);
  });

  it('drops a refused board as a unit of four', () => {
    const units: CardUnit[] = [{ indexes: [0, 1, 2, 3], refusal: CHECKER }, ...singles(10).slice(4)];
    expect(fates(units).slice(0, 4)).toEqual(['0:drop', '1:drop', '2:drop', '3:drop']);
  });

  it('fills up to six with checker-refused cards first, as generated, then validation-refused ones as typed', () => {
    // 7 planned, 3 refused by the checker, 2 by validation: 2 pass, 4 more are needed.
    const units = singles(7, { 0: CHECKER, 1: CHECKER, 2: CHECKER, 3: VALIDATION, 4: VALIDATION });
    const out = keepCards(units, testRng(3));
    const kept = out.filter((c) => c.fate !== 'drop');
    expect(kept).toHaveLength(6);
    expect(out.filter((c) => c.fate === 'keep_refused' && c.shownAs === 'as_generated').map((c) => c.index)).toEqual([0, 1, 2]);
    expect(out.filter((c) => c.fate === 'keep_refused' && c.shownAs === 'typed_translation')).toHaveLength(1);
    expect(out.filter((c) => c.fate === 'drop')).toHaveLength(1);
  });

  it('adds a board whole, even past six', () => {
    // 4 board + 3 singles = 7 planned; the board and one single refused: 2 pass, the board makes 6, the single stays dropped or not by the draw, never a part of the board.
    const units: CardUnit[] = [{ indexes: [0, 1, 2, 3], refusal: CHECKER }, single(4), single(5), single(6, CHECKER)];
    const out = keepCards(units, testRng(5));
    const board = out.filter((c) => c.index < 4).map((c) => c.fate);
    expect(new Set(board).size).toBe(1);
    expect(out.filter((c) => c.fate !== 'drop').length).toBeGreaterThanOrEqual(6);
  });

  it('keeps every card when fewer than six were planned', () => {
    const out = fates(singles(3, { 0: CHECKER, 2: VALIDATION }));
    expect(out).toEqual(['0:as_generated', '1:keep', '2:typed_translation']);
  });

  it('chooses the same cards for the same rng, and draws nothing when no fill is needed', () => {
    const units = singles(8, { 0: CHECKER, 1: CHECKER, 2: CHECKER, 3: CHECKER });
    expect(fates(units, testRng(9))).toEqual(fates(units, testRng(9)));
    let draws = 0;
    keepCards(singles(10, { 9: CHECKER }), () => {
      draws += 1;
      return 0.5;
    });
    expect(draws).toBe(0);
  });
});

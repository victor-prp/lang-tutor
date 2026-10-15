import { describe, expect, it } from '@jest/globals';

import { firstRowPerGloss } from './importRows';

// Phase 53 (ruling R-D9). Each photo is its own import; the rows of several, in import order
// and then position, are one review: a gloss chosen twice is one row, and the first decides.

type Row = { at: string; gloss: string | null };
const glossOf = (row: Row) => row.gloss;
const row = (at: string, gloss: string | null): Row => ({ at, gloss });

describe('firstRowPerGloss', () => {
  it('keeps the first row of a gloss and drops every later one', () => {
    const rows = [row('a0', 'g1'), row('a1', 'g2'), row('b0', 'g1'), row('c0', 'g1')];
    expect(firstRowPerGloss(rows, glossOf)).toEqual([row('a0', 'g1'), row('a1', 'g2')]);
  });

  it('always keeps a row whose gloss is null, not looked up yet or failed, however many there are', () => {
    const rows = [row('a0', null), row('a1', 'g1'), row('b0', null), row('b1', null)];
    expect(firstRowPerGloss(rows, glossOf)).toEqual(rows);
  });

  it('keeps the order it is given: the first import before the next, each by position', () => {
    const rows = [row('b0', 'g3'), row('a0', null), row('a1', 'g1'), row('a2', 'g3'), row('a3', 'g2')];
    expect(firstRowPerGloss(rows, glossOf).map((kept) => kept.at)).toEqual(['b0', 'a0', 'a1', 'a3']);
  });

  it('answers nothing for no rows, and leaves the rows it was given as they were', () => {
    expect(firstRowPerGloss([], glossOf)).toEqual([]);
    const rows = [row('a0', 'g1'), row('b0', 'g1')];
    firstRowPerGloss(rows, glossOf);
    expect(rows).toEqual([row('a0', 'g1'), row('b0', 'g1')]);
  });
});

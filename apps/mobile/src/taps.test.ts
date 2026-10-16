import { describe, expect, it } from '@jest/globals';

import { tappableRuns } from './taps';

describe('tappableRuns (phase 59 D3)', () => {
  const text = 'אני הולך עם חברים.';
  const words = [
    { start: 4, end: 8, text: 'Vado', target: false },
    { start: 9, end: 11, text: 'con', target: true },
    { start: 12, end: 17, text: 'amici', target: false },
  ];

  it("cuts the sentence into plain text and the map's words, each with its index", () => {
    expect(tappableRuns(text, words, { start: 9, end: 11 })).toEqual([
      { text: 'אני ', tap: null },
      { text: 'הולך', tap: 0, translation: 'Vado', target: false },
      { text: ' ', tap: null },
      { text: 'עם', tap: 1, translation: 'con', target: true },
      { text: ' ', tap: null },
      { text: 'חברים', tap: 2, translation: 'amici', target: false },
      { text: '.', tap: null },
    ]);
  });

  it('with no map, makes the mark the one tappable run', () => {
    expect(tappableRuns(text, null, { start: 9, end: 11 })).toEqual([
      { text: 'אני הולך ', tap: null },
      { text: 'עם', tap: 'mark', translation: null, target: true },
      { text: ' חברים.', tap: null },
    ]);
  });

  it('with neither, is the sentence as it is; a run the sentence cannot hold is skipped', () => {
    expect(tappableRuns(text, null, null)).toEqual([{ text, tap: null }]);
    expect(tappableRuns(text, [{ start: 12, end: 99, text: 'x', target: false }], null)).toEqual([{ text, tap: null }]);
  });
});

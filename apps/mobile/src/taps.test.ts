import { describe, expect, it } from '@jest/globals';

import { sentenceUnits, tappableRuns } from './taps';

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

describe('sentenceUnits (phase 59c, design A)', () => {
  const joined = (units: { before: string; text: string; after: string }[]) => units.map((u) => u.before + u.text + u.after).join('');

  it('makes each mapped run a unit, keeping the spaces and punctuation after it', () => {
    const text = 'אני הולך עם חברים היום.';
    const words = [
      { start: 0, end: 8, text: 'vado', target: false },
      { start: 9, end: 11, text: 'con', target: true },
      { start: 12, end: 17, text: 'amici', target: false },
      { start: 18, end: 22, text: 'Oggi', target: false },
    ];
    const units = sentenceUnits(text, words, { start: 9, end: 11 });
    expect(units).toEqual([
      { before: '', text: 'אני הולך', after: ' ', tap: 0, translation: 'vado', target: false },
      { before: '', text: 'עם', after: ' ', tap: 1, translation: 'con', target: true },
      { before: '', text: 'חברים', after: ' ', tap: 2, translation: 'amici', target: false },
      { before: '', text: 'היום', after: '.', tap: 3, translation: 'Oggi', target: false },
    ]);
    expect(joined(units)).toBe(text);
  });

  it('with no map, makes every word a unit and the mark the one tappable one', () => {
    const units = sentenceUnits('יש לי אח.', null, { start: 6, end: 8 });
    expect(units).toEqual([
      { before: '', text: 'יש', after: ' ', tap: null, translation: null, target: false },
      { before: '', text: 'לי', after: ' ', tap: null, translation: null, target: false },
      { before: '', text: 'אח', after: '.', tap: 'mark', translation: null, target: true },
    ]);
  });

  it('keeps a word the map left out as a plain unit, and leading punctuation before the first word', () => {
    const text = '"שלום, עולם!"';
    const units = sentenceUnits(text, [{ start: 7, end: 11, text: 'mondo', target: false }], null);
    expect(units).toEqual([
      { before: '"', text: 'שלום', after: ', ', tap: null, translation: null, target: false },
      { before: '', text: 'עולם', after: '!"', tap: 0, translation: 'mondo', target: false },
    ]);
    expect(joined(units)).toBe(text);
  });
});

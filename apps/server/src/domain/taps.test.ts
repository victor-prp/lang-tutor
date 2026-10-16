import { describe, expect, it } from '@jest/globals';

import { classifyTaps } from './taps';

describe('classifyTaps (phase 59 D4)', () => {
  const words = [
    { start: 0, end: 3, text: 'Vado', glossId: null, target: false },
    { start: 4, end: 6, text: 'con', glossId: null, target: true },
    { start: 7, end: 12, text: 'amici', glossId: 'g-amico', target: false },
  ];

  it('names each tap by what it costs: the target, a list word, a free word', () => {
    expect(classifyTaps(words, [2, 0, 1])).toEqual([
      { index: 2, kind: 'list', glossId: 'g-amico' },
      { index: 0, kind: 'free', glossId: null },
      { index: 1, kind: 'target', glossId: null },
    ]);
  });

  it('drops an index out of range or repeated', () => {
    expect(classifyTaps(words, [0, 0, 7, -1])).toEqual([{ index: 0, kind: 'free', glossId: null }]);
  });

  it('keeps nothing on a card with no word map', () => {
    expect(classifyTaps(null, [0, 1])).toEqual([]);
  });
});

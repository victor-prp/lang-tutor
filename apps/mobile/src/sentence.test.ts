import { describe, expect, it } from '@jest/globals';

import { splitAtGap } from './sentence';

describe('splitAtGap', () => {
  it('cuts a sentence around its gap', () => {
    expect(splitAtGap('Ieri parlavamo per ore.', { start: 5, end: 14 })).toEqual({
      before: 'Ieri ',
      word: 'parlavamo',
      after: ' per ore.',
    });
  });

  it('keeps an empty side empty', () => {
    expect(splitAtGap('Parlavamo ieri.', { start: 0, end: 9 })).toEqual({ before: '', word: 'Parlavamo', after: ' ieri.' });
  });
});

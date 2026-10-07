import { describe, expect, it } from '@jest/globals';

import { showsSentenceTranslation, splitAtGap } from './sentence';

describe('showsSentenceTranslation', () => {
  it('a choice card keeps its Hebrew until answered, since it hints the word', () => {
    expect(showsSentenceTranslation('cloze_choice', false)).toBe(false);
    expect(showsSentenceTranslation('cloze_choice', true)).toBe(true);
  });

  it('a typed gap card always shows it, since it fixes the inflection', () => {
    expect(showsSentenceTranslation('cloze_typed', false)).toBe(true);
    expect(showsSentenceTranslation('cloze_typed', true)).toBe(true);
  });
});

describe('splitAtGap', () => {
  it('cuts a sentence around its gap', () => {
    expect(splitAtGap('Ieri parlavamo per ore.', { start: 5, end: 14 })).toEqual({
      before: 'Ieri ',
      word: 'parlavamo',
      after: ' per ore.',
    });
  });

  it('a gap at the end leaves nothing after', () => {
    expect(splitAtGap('Ieri parlavamo', { start: 5, end: 14 })).toEqual({ before: 'Ieri ', word: 'parlavamo', after: '' });
  });

  it('keeps an empty side empty', () => {
    expect(splitAtGap('Parlavamo ieri.', { start: 0, end: 9 })).toEqual({ before: '', word: 'Parlavamo', after: ' ieri.' });
  });
});

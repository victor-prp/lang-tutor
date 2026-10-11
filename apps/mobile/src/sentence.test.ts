import { describe, expect, it } from '@jest/globals';

import { showsSentenceTranslation, splitAtGap } from './sentence';

describe('showsSentenceTranslation', () => {
  const closed = { answered: false, hintOpen: false, retrying: false };

  it('a choice card keeps its Hebrew until answered, since it hints the word', () => {
    expect(showsSentenceTranslation('cloze_choice', closed)).toBe(false);
    expect(showsSentenceTranslation('cloze_choice', { ...closed, answered: true })).toBe(true);
  });

  it('a typed gap card hides it until the hint, a second try or the answer (phase 38 D1)', () => {
    expect(showsSentenceTranslation('cloze_typed', closed)).toBe(false);
    expect(showsSentenceTranslation('cloze_typed', { ...closed, hintOpen: true })).toBe(true);
    expect(showsSentenceTranslation('cloze_typed', { ...closed, retrying: true })).toBe(true);
    expect(showsSentenceTranslation('cloze_typed', { ...closed, answered: true })).toBe(true);
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

import { describe, expect, it } from '@jest/globals';

import { findMark, findMarks } from './marks';

const marked = (sentence: string, word: string) => {
  const mark = findMark(sentence, word);
  return mark ? sentence.slice(mark.start, mark.end) : null;
};

describe('findMark (phase 34, spec D6, D8)', () => {
  it('finds the word as written, as a whole word', () => {
    expect(findMark('הוא רוצה להוריד את הקובץ', 'להוריד')).toEqual({ start: 9, end: 15 });
    expect(marked('He saws the planks every morning.', 'saws')).toBe('saws');
    // Never inside another word.
    expect(findMark('The seesaw broke.', 'saw')).toBeNull();
  });

  it('ignores case, so a word that opens the sentence is found', () => {
    expect(marked('Saw the plank in half.', 'saw')).toBe('Saw');
    expect(marked('Ведро стоит у двери.', 'ведро')).toBe('Ведро');
  });

  it('finds a phrase across any run of spaces', () => {
    expect(marked('Let us join  forces now.', 'join forces')).toBe('join  forces');
  });

  it('finds a Hebrew word behind a one-letter prefix, and marks the prefix with it', () => {
    expect(marked('אני רוצה ולהוריד את הקובץ', 'להוריד')).toBe('ולהוריד');
    expect(marked('הלכנו לבית הספר', 'בית')).toBe('לבית');
    expect(marked('ראיתי את הספר שקניתי', 'ספר')).toBe('הספר');
  });

  // The plan's הורידה/להוריד: an inflection is no prefix, and the sentence is then kept unmarked.
  it('misses an inflected Hebrew word: null, not a guess', () => {
    expect(findMark('היא הורידה את הקובץ אתמול', 'להוריד')).toBeNull();
    expect(findMark('הורדתי את הקובץ', 'להוריד')).toBeNull();
  });

  it('prefers the word as written to a prefixed one', () => {
    expect(marked('ספר אחד והספר השני', 'ספר')).toBe('ספר');
  });

  it('ignores niqqud in the sentence and in the word, and marks the points with their letters', () => {
    const pointed = 'הוּא קָרָא סֵפֶר יָפֶה';
    expect(marked(pointed, 'ספר')).toBe('סֵפֶר');
    expect(marked('הוא קרא ספר יפה', 'סֵפֶר')).toBe('ספר');
    expect(marked('קָרָא בַּסֵּפֶר', 'ספר')).toBe('בַּסֵּפֶר');
  });

  it('ignores a Russian stress mark', () => {
    expect(marked('Молоко́ стоит на столе.', 'молоко')).toBe('Молоко́');
  });

  it('marks nothing when the word is there twice: which one is meant is a guess', () => {
    expect(findMark('I saw the saw on the bench.', 'saw')).toBeNull();
    expect(findMarks('I saw the saw on the bench.', 'saw')).toHaveLength(2);
  });

  it('marks nothing for an empty word or a word that is absent', () => {
    expect(findMark('He saws the planks.', '')).toBeNull();
    expect(findMark('He saws the planks.', '   ')).toBeNull();
    expect(findMark('He saws the planks.', 'hammer')).toBeNull();
  });

  // The column check counts characters; JavaScript counts UTF-16 units. They
  // agree inside the basic plane, and a mark past it could break the insert.
  it('marks nothing in a sentence with a character outside the basic plane', () => {
    expect(findMark('👍 He saws the planks.', 'saws')).toBeNull();
  });

  it('gives offsets a stored mark can hold: inside the sentence, start before end', () => {
    for (const [sentence, word] of [
      ['בואו נשלב כוחות.', 'נשלב'],
      ['קָרָא בַּסֵּפֶר', 'ספר'],
      ['Saw the plank.', 'saw'],
    ] as const) {
      const mark = findMark(sentence, word)!;
      expect(mark.start).toBeGreaterThanOrEqual(0);
      expect(mark.start).toBeLessThan(mark.end);
      expect(mark.end).toBeLessThanOrEqual(sentence.length);
    }
  });
});

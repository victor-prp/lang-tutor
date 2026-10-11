import { describe, expect, it } from '@jest/globals';

import { contextLanguage, markedParts } from './context';

describe('markedParts (phase 34 D6, D8)', () => {
  it('cuts a sentence around its marked word', () => {
    expect(markedParts('בואו נשלב כוחות.', { start: 5, end: 9 })).toEqual({ before: 'בואו ', word: 'נשלב', after: ' כוחות.' });
  });

  it('marks a word at either end', () => {
    expect(markedParts('I saw it', { start: 2, end: 5 })).toEqual({ before: 'I ', word: 'saw', after: ' it' });
    expect(markedParts('Saw it', { start: 0, end: 3 })).toEqual({ before: '', word: 'Saw', after: ' it' });
    expect(markedParts('He took the saw', { start: 12, end: 15 })).toEqual({ before: 'He took the ', word: 'saw', after: '' });
  });

  it('leaves the sentence unmarked when the server found no word', () => {
    expect(markedParts('הוא ניסר את הקרש.', null)).toBeNull();
  });

  it('leaves the sentence unmarked rather than cut it wrongly when a mark does not fit', () => {
    expect(markedParts('short', { start: 2, end: 9 })).toBeNull();
    expect(markedParts('short', { start: -1, end: 2 })).toBeNull();
    expect(markedParts('short', { start: 3, end: 3 })).toBeNull();
    expect(markedParts('short', { start: 4, end: 2 })).toBeNull();
  });
});

describe('contextLanguage (phase 34 D6)', () => {
  it('is Hebrew under a Hebrew prompt', () => {
    expect(contextLanguage('typed_translation', 'it')).toBe('he');
    expect(contextLanguage('say_translation', 'it')).toBe('he');
    expect(contextLanguage('reverse_choice', 'it')).toBe('he');
  });

  it('is the target language under a target word', () => {
    expect(contextLanguage('typed_meaning', 'it')).toBe('it');
    expect(contextLanguage('multiple_choice', 'en')).toBe('en');
  });
});

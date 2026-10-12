import { describe, expect, it } from '@jest/globals';

import type { LanguageCode } from '../api/types';
import { answerLanguage, isTypedAnswerType, wrongScript } from './script';

describe('wrongScript (phase 39, spec D7)', () => {
  const cases: [string, LanguageCode, boolean][] = [
    ['מציצה', 'en', true],
    ['blow up', 'en', false],
    ['blow up להתפוצץ', 'en', false],
    ['saw', 'he', true],
    ['DNA מולקולה', 'he', false],
    ['книга', 'en', true],
    ['book', 'ru', true],
    ['1990', 'en', false],
    ['...', 'en', false],
    ['', 'en', false],
    ['  ', 'en', false],
  ];
  it.each(cases)('%j in %s is %s', (text, language, expected) => {
    expect(wrongScript(text, language)).toBe(expected);
  });
});

describe('answerLanguage', () => {
  it('is the learner on a typed meaning and the target elsewhere', () => {
    expect(answerLanguage('typed_meaning', 'en', 'he')).toBe('he');
    expect(answerLanguage('dictation', 'en', 'he')).toBe('en');
  });
});

describe('isTypedAnswerType', () => {
  it('excludes letter tiles and choice cards', () => {
    expect(isTypedAnswerType('letter_tiles')).toBe(false);
    expect(isTypedAnswerType('multiple_choice')).toBe(false);
    expect(isTypedAnswerType('cloze_typed')).toBe(true);
  });
});

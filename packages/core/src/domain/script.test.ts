import { describe, expect, it } from '@jest/globals';

import type { LanguageCode, Question } from '../api/types';
import { answerLanguage, gatesScript, isTypedAnswerType, wrongScript } from './script';

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

describe('gatesScript (phase 39, spec D7)', () => {
  const meaning = (text: string): Question => ({
    id: 'q1',
    type: 'typed_meaning',
    vocab_term_id: 'g1',
    question: 'DNA',
    part_of_speech: 'noun',
    meaning: text,
    context: null,
  });
  const typed: Question = {
    id: 'q2',
    type: 'typed_translation',
    vocab_term_id: 'g2',
    question: 'ספר',
    part_of_speech: 'noun',
    answer: 'book',
    lemma: 'book',
    alternatives: [],
    context: null,
  };

  it('checks a typed meaning in the learner language and other typed cards in the target', () => {
    expect(gatesScript(meaning('חתול'), 'en', 'he')).toBe('he');
    expect(gatesScript(typed, 'en', 'he')).toBe('en');
  });

  it('does not check a card whose own right answer has no letter in that alphabet', () => {
    // A Hebrew meaning stored as "DNA" could never be typed past the check.
    expect(gatesScript(meaning('DNA'), 'en', 'he')).toBeNull();
    expect(gatesScript({ ...typed, answer: 'книга' }, 'en', 'he')).toBeNull();
  });

  it('still checks a right answer with no letters, or a mixed one', () => {
    expect(gatesScript(meaning('1990'), 'en', 'he')).toBe('he');
    expect(gatesScript(meaning('DNA מולקולה'), 'en', 'he')).toBe('he');
  });

  it('does not check a card that is not typed', () => {
    const choice: Question = { id: 'q3', type: 'multiple_choice', vocab_term_id: 'g3', question: 'book', options: ['ספר', 'בית'], correct_option: 0, context: null };
    expect(gatesScript(choice, 'en', 'he')).toBeNull();
  });
});

import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { feedbackFor } from './feedback';

const choice: Question = {
  id: 'c',
  type: 'multiple_choice',
  vocab_term_id: 'l',
  question: 'casa',
  options: ['בית', 'דלת'],
  correct_option: 0,
};
const typed: Question = {
  id: 't',
  type: 'typed_translation',
  vocab_term_id: 'l',
  question: 'חלון',
  part_of_speech: 'noun',
  answer: 'finestra',
  lemma: 'finestra',
  alternatives: ['vetrata'],
};

describe('feedbackFor', () => {
  it('a right choice is correct, with no line', () => {
    expect(feedbackFor(choice, { option_index: 0 })).toEqual({
      tone: 'correct',
      title: 'נכון!',
      line: null,
      verdict: null,
    });
  });

  it('a wrong choice shows the right answer', () => {
    expect(feedbackFor(choice, { option_index: 1 })).toEqual({
      tone: 'wrong',
      title: 'התשובה הנכונה:',
      line: 'בית',
      verdict: null,
    });
  });

  it('an exact typed answer is correct, with no line', () => {
    expect(feedbackFor(typed, { text: 'Finestra' })).toEqual({
      tone: 'correct',
      title: 'נכון!',
      line: null,
      verdict: 'exact',
    });
  });

  it('a near miss is correct and shows the spelling', () => {
    expect(feedbackFor(typed, { text: 'finestar' })).toEqual({
      tone: 'correct',
      title: 'כמעט! כך כותבים:',
      line: 'finestra',
      verdict: 'near_miss',
    });
  });

  it('an alternative is correct and names the practised word', () => {
    expect(feedbackFor(typed, { text: 'vetrata' })).toEqual({
      tone: 'correct',
      title: 'נכון! המילה שתרגלנו:',
      line: 'finestra',
      verdict: 'alternative',
    });
  });

  it('an empty answer ("show the answer") is wrong and shows the answer', () => {
    expect(feedbackFor(typed, { text: '' })).toEqual({
      tone: 'wrong',
      title: 'התשובה הנכונה:',
      line: 'finestra',
      verdict: 'wrong',
    });
  });
});

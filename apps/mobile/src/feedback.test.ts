import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { feedbackFor } from './feedback';
import { strings } from './strings';

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

describe('feedbackFor, phase 24', () => {
  const board: Question = {
    id: 'm1', type: 'matching', vocab_term_id: 'l', question: 'casa',
    options: ['בית', 'חתול', 'כלב', 'עץ', 'דלת'], correct_option: 0,
    board: { question_ids: ['m1', 'm2', 'm3', 'm4'], words: ['casa', 'gatto', 'cane', 'albero'], correct_options: [0, 1, 2, 3] },
  };

  it('counts a board by first tries, correct only at all of them', () => {
    expect(feedbackFor(board, { board: [4, 1, 2, 3] })).toEqual({
      tone: 'wrong', title: 'בניסיון הראשון: 3 מתוך 4', line: null, verdict: null,
    });
    expect(feedbackFor(board, { board: [0, 1, 2, 3] }).tone).toBe('correct');
  });

  it('names the heard form after a wrong dictation, and the meaning after a wrong listening card', () => {
    const dictation: Question = { id: 'd', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' };
    expect(feedbackFor(dictation, { text: 'parlare' })).toMatchObject({ tone: 'wrong', line: 'parlo' });
    const listen: Question = { id: 'l', type: 'listen_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 };
    expect(feedbackFor(listen, { option_index: 1 })).toMatchObject({ tone: 'wrong', line: 'בית' });
  });
});

describe('phase 25 banners', () => {
  const READ: Question = { id: 'r', type: 'read_aloud', vocab_term_id: 'l', question: 'gatto', meaning: 'חתול' };
  const SAY: Question = {
    id: 's',
    type: 'say_translation',
    vocab_term_id: 'l',
    question: 'מדבר',
    part_of_speech: 'verb',
    answer: 'parlo',
    lemma: 'parlare',
    alternatives: ['dico'],
  };
  it('names what was heard when understood', () => {
    expect(feedbackFor(READ, { heard: 'il gatto' })).toEqual({
      tone: 'correct',
      title: strings.feedbackHeard,
      line: 'il gatto',
      verdict: 'understood',
    });
  });
  it('names the practised word for an alternative', () => {
    expect(feedbackFor(SAY, { heard: 'dico' })).toEqual({
      tone: 'correct',
      title: strings.feedbackAlternative,
      line: 'parlo',
      verdict: 'alternative',
    });
  });
  it('shows the answer for show the answer, and judges a typed form as typed', () => {
    expect(feedbackFor(SAY, { pass: 'show_answer' })).toMatchObject({ tone: 'wrong', title: strings.feedbackWrong, line: 'parlo' });
    expect(feedbackFor(SAY, { text: 'parlare' })).toMatchObject({ tone: 'correct', verdict: 'exact' });
  });
});

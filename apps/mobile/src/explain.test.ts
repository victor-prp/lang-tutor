import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import { explainPanel, explainText } from './explain';
import { strings } from './strings';

const SENTENCE: Question = {
  id: 's1',
  type: 'sentence_translation',
  vocab_term_id: 'l1',
  question: 'אני רוצה להזמין שולחן.',
  meaning: 'להזמין',
  sentence: 'Voglio prenotare un tavolo.',
  gap: { start: 7, end: 16 },
  answer: 'prenotare',
  mark: null,
};
const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין', context: null };
const mistake = { wrong: 'il tavola', right: 'un tavolo', why: 'tavolo הוא זכר' };

describe('explainText (phase 66 D3): the text the הסבר button explains, or none', () => {
  it("is a translation card's typed answer that is not the reference", () => {
    expect(explainText(SENTENCE, { text: 'Io voglio prenotare il tavola.', judged: 'exact' })).toBe('Io voglio prenotare il tavola.');
    expect(explainText(SENTENCE, { text: 'Voglio un tavolo.', judged: 'wrong' })).toBe('Voglio un tavolo.');
  });
  it('is none for the reference as typed, whatever its case or full stop', () => {
    expect(explainText(SENTENCE, { text: 'voglio prenotare un tavolo', judged: 'exact' })).toBeNull();
  });
  it('is none for an empty answer, a pass, no answer yet, or another card', () => {
    expect(explainText(SENTENCE, { text: '  ', judged: 'wrong' })).toBeNull();
    expect(explainText(SENTENCE, { pass: 'show_answer' })).toBeNull();
    expect(explainText(SENTENCE, null)).toBeNull();
    expect(explainText(MEANING, { text: 'לשריין', judged: 'exact' })).toBeNull();
  });
});

describe('explainPanel (phase 66 D3): what a tap shows', () => {
  it('shows the corrected sentence and each mistake once it has landed', () => {
    expect(explainPanel({ status: 'ready', explanation: { corrected: 'Io voglio prenotare un tavolo.', mistakes: [mistake] } })).toEqual({
      kind: 'mistakes',
      corrected: 'Io voglio prenotare un tavolo.',
      mistakes: [mistake],
    });
  });
  it('says the sentence is right when it has no mistakes', () => {
    expect(explainPanel({ status: 'ready', explanation: { corrected: 'x', mistakes: [] } })).toEqual({ kind: 'line', text: strings.explainNone });
  });
  it('says it is coming while the call is out, and unavailable when it failed', () => {
    expect(explainPanel({ status: 'loading' })).toEqual({ kind: 'line', text: strings.explainLoading });
    expect(explainPanel({ status: 'failed' })).toEqual({ kind: 'line', text: strings.explainFailed });
  });
});

describe('the reason line (phase 66 review I1)', () => {
  // writingDirection is iOS-only; Android takes a paragraph's direction from its
  // first strong letter, so a reason that opens with the Italian word read LTR.
  it('opens with a right-to-left mark, so Android lays it out right to left', () => {
    expect(strings.explainWhy('tavolo הוא שם עצם בזכר')).toBe('\u200Ftavolo הוא שם עצם בזכר');
  });
});

describe('the explain strings (phase 66 D3)', () => {
  it('words them exactly', () => {
    expect(strings.explainButton).toBe('הסבר');
    expect(strings.explainCorrected).toBe('המשפט שלך, מתוקן:');
    expect(strings.explainNone).toBe('המשפט שלך נכון');
    expect(strings.explainLoading).toBe('מכין הסבר…');
    expect(strings.explainFailed).toBe('ההסבר לא זמין כרגע');
  });
});

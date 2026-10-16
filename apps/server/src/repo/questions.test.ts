import { describe, expect, it } from '@jest/globals';

import { questionFrom, type QuestionRow } from './questions';

// Phase 54 (spec D7). The row of a stored question, as the repository selects it.
const ROW: QuestionRow = {
  id: 'q1',
  type: 'meet',
  prompt: 'חתול',
  options: null,
  alternatives: null,
  tiles: null,
  sentence: null,
  sentenceTranslation: null,
  gapStart: null,
  gapEnd: null,
  answerForm: null,
  context: null,
  contextMarkStart: null,
  contextMarkEnd: null,
  sentenceMarkStart: null,
  sentenceMarkEnd: null,
  knownMeanings: null,
  words: null,
  form: 'gatto',
  lemma: 'gatto',
  partOfSpeech: 'noun',
  lexemeId: 'l1',
};

describe('questionFrom, the meet card (phase 54, spec D7)', () => {
  it('builds the card from its row: the form, and the stored prompt as its meaning', () => {
    expect(questionFrom(ROW, null)).toEqual({ id: 'q1', type: 'meet', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' });
  });

  it('ignores a session order: it has no options to put in one', () => {
    expect(questionFrom(ROW, [])).toEqual(questionFrom(ROW, null));
  });
});

describe('questionFrom, a sentence translation (phase 59, spec D5)', () => {
  const row: QuestionRow = {
    ...ROW,
    type: 'sentence_translation',
    prompt: 'עם',
    sentence: 'Vado con amici.',
    sentenceTranslation: 'אני הולך עם חברים.',
    gapStart: 5,
    gapEnd: 8,
    sentenceMarkStart: 9,
    sentenceMarkEnd: 11,
    words: [
      { start: 9, end: 11, text: 'con', glossId: null, target: true },
      { start: 12, end: 17, text: 'amici', glossId: 'g-amico', target: false },
    ],
  };

  it('serves the word map without the list\'s glosses', () => {
    expect(questionFrom(row, null)).toMatchObject({
      words: [
        { start: 9, end: 11, text: 'con', target: true },
        { start: 12, end: 17, text: 'amici', target: false },
      ],
    });
    expect(JSON.stringify(questionFrom(row, null))).not.toContain('g-amico');
  });

  it('serves null for a card stored without one', () => {
    expect(questionFrom({ ...row, words: null }, null)).toMatchObject({ words: null });
  });
});

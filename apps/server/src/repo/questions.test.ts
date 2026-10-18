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
  contextTranslation: null,
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

// Phase 62 (spec D2, D5). A tapped sentence's map, served without the list's glosses,
// and a target-language context line's Hebrew, served for after the answer.
describe('questionFrom: a tapped sentence (phase 62)', () => {
  const words = [
    { start: 0, end: 4, text: 'הבית', glossId: 'g-casa', target: false },
    { start: 7, end: 12, text: 'גדול', glossId: null, target: true },
  ];
  const served = [
    { start: 0, end: 4, text: 'הבית', target: false },
    { start: 7, end: 12, text: 'גדול', target: true },
  ];
  const options = [
    { position: 0, text: 'בית', is_correct: true },
    { position: 1, text: 'דלת', is_correct: false },
  ];
  const line = { context: 'Casa è grande.', contextTranslation: 'הבית גדול.', contextMarkStart: 0, contextMarkEnd: 4, words };

  it('serves a cloze card its map', () => {
    const cloze = questionFrom({ ...ROW, type: 'cloze_choice', prompt: 'גדול', options, sentence: 'Casa è grande.', sentenceTranslation: 'הבית גדול.', gapStart: 7, gapEnd: 13, words }, null);
    expect(cloze).toMatchObject({ type: 'cloze_choice', words: served });
    expect(JSON.stringify(cloze)).not.toContain('g-casa');
  });

  it('serves a multiple choice, a typed meaning and a new meaning the line\'s map and Hebrew', () => {
    for (const type of ['multiple_choice', 'typed_meaning', 'new_meaning'] as const) {
      const question = questionFrom({ ...ROW, type, prompt: 'בית', options: type === 'typed_meaning' ? null : options, knownMeanings: type === 'new_meaning' ? ['x'] : null, ...line }, null);
      expect(question).toMatchObject({ context: { text: 'Casa è grande.', mark: { start: 0, end: 4 }, words: served, translation: 'הבית גדול.' } });
    }
  });

  it('serves a Hebrew line as before: no map and no other half', () => {
    const reverse = questionFrom({ ...ROW, type: 'reverse_choice', prompt: 'בית', options, ...line, context: 'הבית גדול.', contextTranslation: 'Casa è grande.' }, null);
    expect((reverse as { context: unknown }).context).toEqual({ text: 'הבית גדול.', mark: { start: 0, end: 4 } });
  });
});

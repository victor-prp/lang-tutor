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

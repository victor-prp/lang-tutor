import { describe, expect, it } from '@jest/globals';

import {
  JUDGE_MARKER,
  buildMeaningJudgePrompt,
  meaningRuleVerdict,
  parseMeaningJudge,
  type MeaningJudgeContext,
} from './judge';

const CONTEXT: MeaningJudgeContext = {
  language: 'it',
  form: 'prenotare',
  lemma: 'prenotare',
  partOfSpeech: 'verb',
  meaning: 'להזמין',
  example: 'Vorrei prenotare un tavolo.',
  exampleTranslation: 'הייתי רוצה להזמין שולחן.',
};

describe('meaningRuleVerdict (spec D3 step 2)', () => {
  it('is wrong for an empty answer, without a call', () => {
    expect(meaningRuleVerdict('להזמין', '   ')).toBe('wrong');
  });
  it('is exact for the stored meaning, with points, a maqaf or a full stop', () => {
    expect(meaningRuleVerdict('להזמין', 'לְהַזְמִין.')).toBe('exact');
    expect(meaningRuleVerdict('בית ספר', 'בית־ספר')).toBe('exact');
  });
  it('leaves anything else to the model', () => {
    expect(meaningRuleVerdict('להזמין', 'לשריין')).toBeNull();
  });
});

describe('buildMeaningJudgePrompt (spec D4)', () => {
  const prompt = buildMeaningJudgePrompt(CONTEXT, 'לשריין');
  it('carries the marker MockServer matches on, and the language', () => {
    expect(prompt.system).toContain(JUDGE_MARKER);
    expect(prompt.system).toContain('Italian');
  });
  it('sends the word, its sense and the answer', () => {
    expect(JSON.parse(prompt.user)).toEqual({
      word: 'prenotare',
      lemma: 'prenotare',
      part_of_speech: 'verb',
      saved_meaning: 'להזמין',
      example: 'Vorrei prenotare un tavolo.',
      example_translation: 'הייתי רוצה להזמין שולחן.',
      answer: 'לשריין',
    });
  });
  it('names all three verdicts', () => {
    for (const verdict of ['"right"', '"other_sense"', '"wrong"']) expect(prompt.system).toContain(verdict);
  });
});

describe('parseMeaningJudge (spec D4)', () => {
  it('maps the three verdicts onto typed verdicts', () => {
    expect(parseMeaningJudge('{"verdict":"right"}')).toBe('exact');
    expect(parseMeaningJudge('{"verdict":"other_sense"}')).toBe('alternative');
    expect(parseMeaningJudge('{"verdict":"wrong"}')).toBe('wrong');
  });
  it('is null for no content, a fenced or unknown answer it cannot read', () => {
    expect(parseMeaningJudge('')).toBeNull();
    expect(parseMeaningJudge('{"verdict":"misspelled"}')).toBeNull();
    expect(parseMeaningJudge('not json')).toBeNull();
  });
  it('reads a fenced answer', () => {
    expect(parseMeaningJudge('```json\n{"verdict":"right"}\n```')).toBe('exact');
  });
});

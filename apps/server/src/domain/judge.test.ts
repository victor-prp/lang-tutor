import { describe, expect, it } from '@jest/globals';

import {
  JUDGE_MARKER,
  buildMeaningJudgePrompt,
  buildTranslationJudgePrompt,
  judgePrompt,
  meaningRuleVerdict,
  parseJudge,
  parseMeaningJudge,
  parseTranslationJudge,
  ruleVerdict,
  translationRuleVerdict,
  type JudgeContext,
} from './judge';

const CONTEXT: JudgeContext = {
  language: 'it',
  explanation: 'he',
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
    expect(prompt.system).toContain('Hebrew-speaking learner');
  });
  it('names the enrollment source language, not always Hebrew', () => {
    const system = buildMeaningJudgePrompt({ ...CONTEXT, explanation: 'en' }, 'x').system;
    expect(system).toContain('English-speaking learner');
    expect(system).toContain('in English');
    expect(system).not.toContain('Hebrew-speaking');
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

const QUESTION = {
  id: 'q1',
  type: 'sentence_translation' as const,
  vocab_term_id: 'l1',
  question: 'אני רוצה להזמין שולחן.',
  meaning: 'להזמין',
  sentence: 'I want to book a table.',
  gap: { start: 10, end: 14 },
  answer: 'book',
};
const MEANING_Q = { id: 'm1', type: 'typed_meaning' as const, vocab_term_id: 'l1', question: 'prenotare', part_of_speech: 'verb', meaning: 'להזמין' };

describe('translationRuleVerdict', () => {
  it('is wrong for an empty answer', () => {
    expect(translationRuleVerdict('I want to book a table.', '  ')).toBe('wrong');
  });
  it('is exact for the reference in another case without the full stop', () => {
    expect(translationRuleVerdict('I want to book a table.', 'i want to BOOK a table')).toBe('exact');
  });
  it('leaves anything else to the model', () => {
    expect(translationRuleVerdict('I want to book a table.', 'I want a table')).toBeNull();
  });
});

describe('buildTranslationJudgePrompt', () => {
  const prompt = buildTranslationJudgePrompt(QUESTION, CONTEXT, 'I want to bok a table');
  it('carries the marker and the target language', () => {
    expect(prompt.system).toContain(JUDGE_MARKER);
    expect(prompt.system).toContain('Italian');
  });
  it('names the source language of the enrollment', () => {
    expect(prompt.system).toContain('the Hebrew sentence');
    expect(buildTranslationJudgePrompt(QUESTION, { ...CONTEXT, explanation: 'en' }, 'x').system).toContain('the English sentence');
  });
  it('sends the sentence, the reference, the word and the answer', () => {
    expect(JSON.parse(prompt.user)).toEqual({
      hebrew_sentence: 'אני רוצה להזמין שולחן.',
      reference_translation: 'I want to book a table.',
      word: 'prenotare',
      lemma: 'prenotare',
      part_of_speech: 'verb',
      meaning: 'להזמין',
      answer: 'I want to bok a table',
    });
  });
  it('names the four verdicts and what each means', () => {
    for (const verdict of ['"right"', '"misspelled"', '"other_word"', '"wrong"']) expect(prompt.system).toContain(verdict);
    expect(prompt.system).toContain('conveying the');
    expect(prompt.system).toContain('any form the sentence needs');
    expect(prompt.system).toContain('ignore slips in other words');
    expect(prompt.system).toContain('one-letter or accent slip');
    expect(prompt.system).toContain('another word instead of it');
    expect(prompt.system).toContain('including the wrong form');
  });
});

describe('parseTranslationJudge', () => {
  it('maps the four verdicts', () => {
    expect(parseTranslationJudge('{"verdict":"right"}')).toBe('exact');
    expect(parseTranslationJudge('{"verdict":"misspelled"}')).toBe('near_miss');
    expect(parseTranslationJudge('{"verdict":"other_word"}')).toBe('alternative');
    expect(parseTranslationJudge('{"verdict":"wrong"}')).toBe('wrong');
  });
  it('is null for other_sense, empty or junk', () => {
    expect(parseTranslationJudge('{"verdict":"other_sense"}')).toBeNull();
    expect(parseTranslationJudge('')).toBeNull();
    expect(parseTranslationJudge('junk')).toBeNull();
  });
  it('reads a fenced answer', () => {
    expect(parseTranslationJudge('```json\n{"verdict":"right"}\n```')).toBe('exact');
  });
});

describe('the dispatchers', () => {
  it('route each judged type', () => {
    expect(ruleVerdict(MEANING_Q, 'להזמין')).toBe('exact');
    expect(ruleVerdict(QUESTION, 'i want to book a table')).toBe('exact');
    expect(JSON.parse(judgePrompt(MEANING_Q, CONTEXT, 'x').user)).toHaveProperty('saved_meaning');
    expect(JSON.parse(judgePrompt(QUESTION, CONTEXT, 'x').user)).toHaveProperty('reference_translation');
    expect(parseJudge('typed_meaning', '{"verdict":"other_sense"}')).toBe('alternative');
    expect(parseJudge('sentence_translation', '{"verdict":"misspelled"}')).toBe('near_miss');
    expect(parseJudge('sentence_translation', '{"verdict":"other_sense"}')).toBeNull();
  });
});

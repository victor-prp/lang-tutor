import { describe, expect, it } from '@jest/globals';

import { EXPLAIN_MARKER, MAX_MISTAKES, buildExplainPrompt, explainRuleResult, parseExplain } from './explain';
import { JUDGE_MARKER, type JudgeContext } from './judge';

const CONTEXT: JudgeContext = {
  language: 'it',
  explanation: 'he',
  form: 'prenotare',
  lemma: 'prenotare',
  partOfSpeech: 'verb',
  meaning: 'להזמין',
  example: null,
  exampleTranslation: null,
};

const QUESTION = {
  id: 'q1',
  type: 'sentence_translation' as const,
  vocab_term_id: 'l1',
  question: 'אני רוצה להזמין שולחן.',
  meaning: 'להזמין',
  sentence: 'Voglio prenotare un tavolo.',
  gap: { start: 7, end: 16 },
  answer: 'prenotare',
  mark: null,
};

const mistake = { wrong: 'il tavola', right: 'un tavolo', why: 'tavolo הוא שם עצם בזכר' };

describe('buildExplainPrompt (spec D2)', () => {
  const prompt = buildExplainPrompt(QUESTION, CONTEXT, 'Io voglio prenotare il tavola.');
  it('carries its own marker, never the judge marker', () => {
    expect(prompt.system).toContain(EXPLAIN_MARKER);
    expect(prompt.system).not.toContain(JUDGE_MARKER);
  });
  it('names both languages and asks for the reasons in the learner language', () => {
    expect(prompt.system).toContain('Italian');
    expect(prompt.system).toContain('in Hebrew');
  });
  it('says a different but valid wording is not a mistake', () => {
    expect(prompt.system).toContain('not a mistake');
  });
  it('sends the sentence, the reference, the word and the answer', () => {
    expect(JSON.parse(prompt.user)).toEqual({
      hebrew_sentence: 'אני רוצה להזמין שולחן.',
      reference_translation: 'Voglio prenotare un tavolo.',
      word: 'prenotare',
      meaning: 'להזמין',
      answer: 'Io voglio prenotare il tavola.',
    });
  });
});

describe('parseExplain', () => {
  it('reads the corrected sentence and the mistakes', () => {
    expect(parseExplain(JSON.stringify({ corrected: 'Io voglio prenotare un tavolo.', mistakes: [mistake] }))).toEqual({
      corrected: 'Io voglio prenotare un tavolo.',
      mistakes: [mistake],
    });
  });
  it('reads a fenced body', () => {
    expect(parseExplain('```json\n{"corrected":"x","mistakes":[]}\n```')).toEqual({ corrected: 'x', mistakes: [] });
  });
  it('is null for an empty, unreadable or incomplete body', () => {
    expect(parseExplain('')).toBeNull();
    expect(parseExplain('not json')).toBeNull();
    expect(parseExplain('{"mistakes":[]}')).toBeNull();
    expect(parseExplain('{"corrected":"x","mistakes":[{"wrong":"a","right":"b"}]}')).toBeNull();
  });
  it(`keeps at most ${MAX_MISTAKES} mistakes`, () => {
    const many = Array.from({ length: MAX_MISTAKES + 3 }, (_, i) => ({ ...mistake, wrong: `w${i}` }));
    const parsed = parseExplain(JSON.stringify({ corrected: 'x', mistakes: many }));
    expect(parsed?.mistakes.map((m) => m.wrong)).toEqual(many.slice(0, MAX_MISTAKES).map((m) => m.wrong));
  });
});

describe('explainRuleResult', () => {
  it('has no mistakes for an empty answer, without a call', () => {
    expect(explainRuleResult('Voglio prenotare un tavolo.', '  ')).toEqual({ corrected: '', mistakes: [] });
  });
  it('has no mistakes for the reference as typed, whatever its case or full stop', () => {
    expect(explainRuleResult('Voglio prenotare un tavolo.', 'voglio prenotare un tavolo')).toEqual({
      corrected: 'voglio prenotare un tavolo',
      mistakes: [],
    });
  });
  it('leaves anything else to the model', () => {
    expect(explainRuleResult('Voglio prenotare un tavolo.', 'Io voglio prenotare il tavola.')).toBeNull();
  });
});

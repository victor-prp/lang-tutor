import { describe, expect, it } from '@jest/globals';

import {
  buildPrompt,
  detectDirection,
  normalizeSenses,
  parseLlmTranslation,
  resolveKind,
} from './translation';

describe('detectDirection', () => {
  it('reads Latin script as English to Hebrew', () => {
    expect(detectDirection('book')).toBe('en_he');
    expect(detectDirection('break a leg')).toBe('en_he');
  });

  it('reads any Hebrew character as Hebrew to English', () => {
    expect(detectDirection('מזלג')).toBe('he_en');
    expect(detectDirection('ספר')).toBe('he_en');
  });

  it('treats mixed input as Hebrew, because one Hebrew letter settles it', () => {
    expect(detectDirection('the ספר')).toBe('he_en');
  });

  it('falls back to en_he for input with no letters at all', () => {
    expect(detectDirection('123')).toBe('en_he');
  });
});

describe('resolveKind', () => {
  it('forces word for a single token, whatever the model said', () => {
    expect(resolveKind('book', 'sentence')).toBe('word');
    expect(resolveKind('  book  ', 'phrase')).toBe('word');
  });

  it('trusts the model once there is internal whitespace', () => {
    expect(resolveKind('break a leg', 'phrase')).toBe('phrase');
    expect(resolveKind('I read a book', 'sentence')).toBe('sentence');
  });
});

describe('buildPrompt', () => {
  it('puts only the learner text in the user part', () => {
    expect(buildPrompt({ text: 'book', direction: 'en_he' }).user).toBe('book');
  });

  it('states the direction in the system part', () => {
    expect(buildPrompt({ text: 'book', direction: 'en_he' }).system).toContain('English');
    expect(buildPrompt({ text: 'ספר', direction: 'he_en' }).system).toContain('Hebrew');
  });

  it('carries the three rules that exist because of specific failures', () => {
    const { system } = buildPrompt({ text: 'break a leg', direction: 'en_he' });
    expect(system).toMatch(/imperative/i); // fixed expressions stay phrases
    expect(system).toMatch(/idiom/i); // translated by meaning, not word by word
    expect(system).toMatch(/exactly one sense/i); // a sentence is not polysemous
  });

  it('caps senses and forbids inventing a translation', () => {
    const { system } = buildPrompt({ text: 'asdkjhasd', direction: 'en_he' });
    expect(system).toMatch(/at most 5/i);
    expect(system).toMatch(/empty/i);
  });

  it('hands over the Zod schema itself, not a JSON Schema document', () => {
    const { schema } = buildPrompt({ text: 'book', direction: 'en_he' });
    expect(typeof schema.safeParse).toBe('function');
  });
});

describe('parseLlmTranslation', () => {
  it('parses a well-formed response', () => {
    const raw = JSON.stringify({ kind: 'word', senses: [{ translation: 'ספר' }] });
    expect(parseLlmTranslation(raw)).toEqual({ kind: 'word', senses: [{ translation: 'ספר' }] });
  });

  it('treats null and absent identically, so an OpenAI-style response still parses', () => {
    const raw = JSON.stringify({
      kind: 'sentence',
      senses: [{ translation: 'קראתי ספר.', part_of_speech: null, example: null }],
    });
    const parsed = parseLlmTranslation(raw);
    expect(parsed).toEqual({ kind: 'sentence', senses: [{ translation: 'קראתי ספר.' }] });
    expect(parsed?.senses[0]).not.toHaveProperty('part_of_speech');
  });

  it('returns null for output that is not JSON', () => {
    expect(parseLlmTranslation('I cannot help with that.')).toBeNull();
    expect(parseLlmTranslation('')).toBeNull();
  });

  it('returns null for JSON of the wrong shape', () => {
    expect(parseLlmTranslation(JSON.stringify({ senses: [] }))).toBeNull();
    expect(parseLlmTranslation(JSON.stringify({ kind: 'clause', senses: [] }))).toBeNull();
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', senses: [{}] }))).toBeNull();
  });

  it('returns null when the model exceeds the five-sense cap', () => {
    const senses = Array(6).fill({ translation: 'x' });
    expect(parseLlmTranslation(JSON.stringify({ kind: 'word', senses }))).toBeNull();
  });

  it('accepts a fenced code block, which models emit even when told not to', () => {
    const raw = '```json\n{"kind":"word","senses":[{"translation":"ספר"}]}\n```';
    expect(parseLlmTranslation(raw)).toEqual({ kind: 'word', senses: [{ translation: 'ספר' }] });
  });
});

describe('normalizeSenses', () => {
  it('reduces a sentence to one sense with no part of speech and no example', () => {
    const senses = [
      {
        translation: 'קראתי ספר על החלל.',
        part_of_speech: 'verb',
        example: { source: 'x', target: 'y' },
      },
      { translation: 'משהו אחר' },
    ];
    expect(normalizeSenses('sentence', senses)).toEqual([{ translation: 'קראתי ספר על החלל.' }]);
  });

  it('leaves a word and a phrase untouched', () => {
    const senses = [{ translation: 'ספר', part_of_speech: 'noun' }];
    expect(normalizeSenses('word', senses)).toEqual(senses);
    expect(normalizeSenses('phrase', senses)).toEqual(senses);
  });

  it('handles an empty list', () => {
    expect(normalizeSenses('sentence', [])).toEqual([]);
  });
});

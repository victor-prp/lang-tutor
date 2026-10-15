import type { Question } from '@lang-tutor/core/api';
import { describe, expect, it } from '@jest/globals';

import { scriptGate, typedSubmit } from './typedSubmit';

describe('typedSubmit (phase 39 D8)', () => {
  it('refuses Hebrew on an English card', () => {
    expect(typedSubmit('מציצה', 'en')).toBe('wrong_script');
  });
  it('refuses Latin on a Hebrew card', () => {
    expect(typedSubmit('book', 'he')).toBe('wrong_script');
  });
  it('gives up on empty or blank text', () => {
    expect(typedSubmit('', 'en')).toBe('empty');
    expect(typedSubmit('   ', 'ru')).toBe('empty');
  });
  it('sends right-alphabet and mixed text', () => {
    expect(typedSubmit('book', 'en')).toBe('send');
    expect(typedSubmit('ספר book', 'en')).toBe('send');
    expect(typedSubmit('лук', 'ru')).toBe('send');
  });
  it('sends digits and punctuation, and anything on a card that is not checked', () => {
    expect(typedSubmit('123 ?!', 'he')).toBe('send');
    expect(typedSubmit('מציצה', null)).toBe('send');
  });
});

describe('typedSubmit on a translation card', () => {
  const reference = 'This mushroom grew fast.';
  it('asks for the whole sentence when one word is typed', () => {
    expect(typedSubmit('mushroom ', 'en', reference)).toBe('word_only');
  });
  it('sends a sentence', () => {
    expect(typedSubmit('This mushroom grows fast', 'en', reference)).toBe('send');
  });
  it('names the wrong alphabet before the missing sentence, and gives up on empty text', () => {
    expect(typedSubmit('פטריה', 'en', reference)).toBe('wrong_script');
    expect(typedSubmit('  ', 'en', reference)).toBe('empty');
  });
  it('sends one word on a card with no sentence', () => {
    expect(typedSubmit('mushroom', 'en')).toBe('send');
  });
});

describe('scriptGate (phase 39 D7, D8)', () => {
  const meaning = (text: string): Question => ({
    id: 'q1',
    type: 'typed_meaning',
    vocab_term_id: 'g1',
    question: 'DNA',
    part_of_speech: 'noun',
    meaning: text,
    context: null,
  });

  it('checks a typed meaning in the learner language', () => {
    expect(scriptGate(meaning('חתול'), 'en', 'he')).toBe('he');
    expect(typedSubmit('cat', scriptGate(meaning('חתול'), 'en', 'he'))).toBe('wrong_script');
  });
  it('sends Latin to a typed meaning whose own meaning is Latin ("DNA"), as the server takes it', () => {
    expect(scriptGate(meaning('DNA'), 'en', 'he')).toBeNull();
    expect(typedSubmit('DNA', scriptGate(meaning('DNA'), 'en', 'he'))).toBe('send');
  });
  it('never checks a language the app has no script for', () => {
    expect(scriptGate(meaning('חתול'), '', 'he')).toBeNull();
    expect(scriptGate(meaning('חתול'), 'en', 'xx')).toBeNull();
  });
});

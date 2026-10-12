import { describe, expect, it } from '@jest/globals';

import { typedSubmit } from './typedSubmit';

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
  it('sends digits and punctuation, and an unknown language', () => {
    expect(typedSubmit('123 ?!', 'he')).toBe('send');
    expect(typedSubmit('מציצה', '')).toBe('send');
  });
});

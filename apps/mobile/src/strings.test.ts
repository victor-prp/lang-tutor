import { describe, expect, it } from '@jest/globals';

import { strings } from './strings';

describe('language names', () => {
  it('names Italian in every string composed from a language code', () => {
    expect(strings.languageName('it')).toBe('איטלקית');
    expect(strings.translateDirection('it', 'he')).toBe('מאיטלקית לעברית');
    expect(strings.translateDirection('he', 'it')).toBe('מעברית לאיטלקית');
    expect(strings.vocabularyTitle('it')).toBe('אוצר המילים שלי באיטלקית');
  });
});

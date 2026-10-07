import { describe, expect, it } from '@jest/globals';

import { strings } from './strings';

describe('sentence-card strings (phase 27 D5, D6)', () => {
  it('words the three instructions and the reference label exactly', () => {
    expect(strings.questionInstructionCloze).toBe('איזו מילה חסרה?');
    expect(strings.questionInstructionClozeTyped('it')).toBe('השלימו את המילה החסרה באיטלקית');
    expect(strings.questionInstructionTranslate('it')).toBe('תרגמו לאיטלקית');
    expect(strings.translationReference).toBe('תרגום לדוגמה:');
  });
});

describe('language names', () => {
  it('names Italian in every string composed from a language code', () => {
    expect(strings.languageName('it')).toBe('איטלקית');
    expect(strings.translateDirection('it', 'he')).toBe('מאיטלקית לעברית');
    expect(strings.translateDirection('he', 'it')).toBe('מעברית לאיטלקית');
    expect(strings.vocabularyTitle('it')).toBe('אוצר המילים שלי באיטלקית');
  });
});

describe('textDirection', () => {
  // Phase 23. A he → it lookup's Italian was forced right-to-left, which put an
  // example's full stop at the start of its line.
  it('is right-to-left for Hebrew only', () => {
    expect(strings.textDirection('he')).toBe('rtl');
    expect(strings.textDirection('it')).toBe('ltr');
    expect(strings.textDirection('en')).toBe('ltr');
    expect(strings.textDirection('ru')).toBe('ltr');
  });
});

describe('meaning-recall strings (phase 27 D12)', () => {
  it('words the instruction and both banners exactly', () => {
    expect(strings.questionInstructionMeaning).toBe('כתבו את הפירוש בעברית');
    expect(strings.feedbackSavedMeaning).toBe('נכון! הפירוש השמור:');
    expect(strings.feedbackOtherSense).toBe('נכון, אבל כאן תרגלנו:');
  });
});

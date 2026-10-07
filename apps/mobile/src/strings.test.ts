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

describe('words from a photo', () => {
  // Phase 26. Each number is isolated, as vocabularyMark is: a run with no strong
  // direction is reordered by the RTL layout on Android.
  it('isolates every number', () => {
    expect(strings.photoImportLookingUp(12, 32)).toBe('מחפשים מילים: ⁦12/32⁩');
    expect(strings.photoImportSave(28)).toBe('שמירת ⁦28⁩ מילים');
    expect(strings.photoImportSaved(28)).toBe('⁦28⁩ מילים נשמרו');
    expect(strings.photoImportWordCount(3)).toBe('⁦3⁩ מילים');
    expect(strings.homePhotoReady(32)).toBe('רשימה מתמונה: ⁦32⁩ מילים לסקירה');
    expect(strings.homePhotoSeveral(2)).toBe('⁦2⁩ רשימות מתמונות מחכות לסקירה');
  });

  it('names the language an empty photo had no words in', () => {
    expect(strings.photoImportNoWords(strings.languageName('it'))).toBe('לא נמצאו מילים באיטלקית בתמונה');
  });
});

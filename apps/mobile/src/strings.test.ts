import { describe, expect, it } from '@jest/globals';

import { strings } from './strings';

describe('sentence-card strings (phase 27 D5, D6)', () => {
  it('words the three instructions and the reference label exactly', () => {
    expect(strings.questionInstructionCloze).toBe('איזו מילה חסרה?');
    expect(strings.questionInstructionClozeTyped('it')).toEqual({ before: 'השלימו את המילה החסרה ב', language: 'איטלקית', after: '' });
    expect(strings.questionInstructionTranslate('it')).toEqual({ before: 'תרגמו את המשפט ל', language: 'איטלקית', after: '' });
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

describe('meaning-recall strings (phase 27 D12)', () => {
  it('words the instruction and both banners exactly', () => {
    expect(strings.questionInstructionMeaning('he')).toEqual({ before: 'כתבו את הפירוש ב', language: 'עברית', after: '' });
    expect(strings.feedbackSavedMeaning).toBe('נכון! הפירוש השמור:');
    expect(strings.feedbackOtherSense).toBe('נכון, אבל כאן תרגלנו:');
  });
});

describe('second-try strings (phase 34 D9)', () => {
  it('words both lines exactly, the first answer isolated inside the Hebrew line', () => {
    // FSI/PDI, as heardLine's: a target word or a whole sentence inside a Hebrew line.
    expect(strings.retryRight('vetrata')).toBe('✓ נכון, ⁨vetrata⁩ מתאים כאן.');
    expect(strings.retryAnotherWord).toBe('יש מילה נוספת ששמרת — נסו שוב');
    expect(strings.retryAnotherMeaning).toBe('יש פירוש נוסף — נסו שוב');
  });
});

describe('typed gap hint strings (phase 38 D1, D3)', () => {
  it('names what the hint shows, and says why it opened on a second try', () => {
    expect(strings.sentenceHint).toBe('רמז: הצגת המשפט בעברית');
    expect(strings.retryMeantAnother).toBe('אבל התכוונו למילה אחרת — היעזרו במשפט בעברית ונסו שוב');
  });
});

describe('new-meaning strings (phase 39 D6)', () => {
  it('words the instruction, the known-meanings line and the question exactly', () => {
    expect(strings.questionInstructionNewMeaning).toBe('פירוש חדש למילה שאתם מכירים');
    expect(strings.knownMeanings(['להרים', 'לאסוף'])).toBe('כבר למדתם: להרים, לאסוף');
    expect(strings.newMeaningQuestion).toBe('מה עוד זה אומר?');
  });
});

describe('instructions with a bold language (phase 39 D9)', () => {
  it('splits each typed instruction around the language name', () => {
    expect(strings.questionInstructionTyped('it')).toEqual({ before: 'כתבו את המילה ב', language: 'איטלקית', after: '' });
    expect(strings.questionInstructionDictation('ru')).toEqual({ before: 'הקשיבו וכתבו ב', language: 'רוסית', after: '' });
    expect(strings.questionInstructionClozeTyped('it')).toEqual({ before: 'השלימו את המילה החסרה ב', language: 'איטלקית', after: '' });
    expect(strings.questionInstructionTranslate('it')).toEqual({ before: 'תרגמו את המשפט ל', language: 'איטלקית', after: '' });
    expect(strings.wrongScriptNotice('en')).toEqual({ before: 'התשובה צריכה להיות ב', language: 'אנגלית', after: '' });
  });
});

describe('the translation card asks for the whole sentence', () => {
  it('words the notice for one word on its own', () => {
    expect(strings.wordOnlyNotice).toBe('כתבו את כל המשפט, לא רק את המילה');
  });
});

describe('the Reminders screen (phase 52 D8)', () => {
  it('words the permission notice, its two buttons and the web line exactly', () => {
    expect(strings.remindersDeniedNotice).toBe('Reminders are off in Android settings.');
    expect(strings.remindersEnable).toBe('Turn on notifications');
    expect(strings.remindersWebNotice).toBe('Reminders reach the Android app.');
  });

  it('names the seven days Monday to Sunday by their ISO weekday', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(strings.remindersDayName)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
  });
});

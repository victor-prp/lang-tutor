import { describe, expect, it } from '@jest/globals';

import { strings } from './strings';

describe('sentence-card strings (phase 27 D5, D6)', () => {
  it('words the three instructions and the reference label exactly', () => {
    expect(strings.questionInstructionCloze).toBe('איזו מילה חסרה?');
    expect(strings.questionInstructionClozeTyped('it')).toEqual({ before: 'השלימו את המילה החסרה ב', language: 'איטלקית', after: '' });
    expect(strings.questionInstructionTranslate('it')).toEqual({ before: 'תרגמו את כל המשפט ל', language: 'איטלקית', after: '' });
    expect(strings.translationReference).toBe('תרגום לדוגמה:');
  });
});

describe('the meet card (phase 54 D1)', () => {
  it('words its title and its button exactly', () => {
    expect(strings.meetTitle).toBe('מילה חדשה');
    expect(strings.continueLabel).toBe('המשך');
  });

  // Phase 55 (spec D1): saying the word moved to the read-aloud card, which listens.
  it('no longer asks to say the word', () => {
    expect('meetSayAloud' in strings).toBe(false);
  });
});

describe('help, and the retype (phase 55 D7)', () => {
  it('words the help, the wrong tile, the retype and the helped banner exactly', () => {
    expect(strings.help).toBe('עזרה');
    expect(strings.tilesWrong).toBe('לא האות הזאת');
    expect(strings.retypeNotice).toBe('הקלידו את המילה שוב');
    expect(strings.tryAgain).toBe('נסו שוב');
    expect(strings.feedbackHelped).toBe('נכון, עם עזרה');
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
    expect(strings.questionInstructionMeaning('he')).toEqual({ before: 'תרגמו את המילה ל', language: 'עברית', after: '' });
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
    expect(strings.newMeaningQuestion).toBe('מה עוד המילה אומרת?');
  });
});

describe('instructions with a bold language (phase 39 D9)', () => {
  it('splits each typed instruction around the language name', () => {
    expect(strings.questionInstructionTyped('it')).toEqual({ before: 'תרגמו את המילה ל', language: 'איטלקית', after: '' });
    expect(strings.questionInstructionDictation('ru')).toEqual({ before: 'הקשיבו וכתבו ב', language: 'רוסית', after: '' });
    expect(strings.questionInstructionClozeTyped('it')).toEqual({ before: 'השלימו את המילה החסרה ב', language: 'איטלקית', after: '' });
    expect(strings.questionInstructionTranslate('it')).toEqual({ before: 'תרגמו את כל המשפט ל', language: 'איטלקית', after: '' });
    expect(strings.wrongScriptNotice('en')).toEqual({ before: 'התשובה צריכה להיות ב', language: 'אנגלית', after: '' });
  });
});

describe('the translation card asks for the whole sentence', () => {
  it('words the notice for one word on its own', () => {
    expect(strings.wordOnlyNotice).toBe('כתבו את כל המשפט, לא רק את המילה');
  });
});

describe('the Reminders screen (phase 52 D8)', () => {
  it('words every line in Hebrew, the permission notice and its two buttons exactly', () => {
    expect(strings.remindersEntry).toBe('תזכורות');
    expect(strings.remindersTitle).toBe('תזכורות');
    expect(strings.remindersEnabled).toBe('תזכורות לתרגול');
    expect(strings.remindersTargetLabel).toBe('תרגולים ביום');
    expect(strings.remindersDaysLabel).toBe('ימים');
    expect(strings.remindersTimesLabel).toBe('שעות');
    expect(strings.remindersDeniedNotice).toBe('התזכורות כבויות בהגדרות של אנדרואיד.');
    expect(strings.remindersOpenSettings).toBe('לפתיחת ההגדרות');
    expect(strings.remindersEnable).toBe('הפעלת התראות');
    expect(strings.remindersWebNotice).toBe('התזכורות מגיעות לאפליקציה באנדרואיד.');
    expect(strings.remindersLoadFailed).toBe('טעינת התזכורות נכשלה. אפשר לנסות שוב.');
    expect(strings.remindersSaveFailed).toBe('שמירת התזכורות נכשלה. אפשר לנסות שוב.');
    expect(strings.remindersTargetLess).toBe('פחות תרגולים');
    expect(strings.remindersTargetMore).toBe('יותר תרגולים');
  });

  it('names the days by their ISO weekday, Monday 1 to Sunday 7, by the Hebrew letter of the day', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(strings.remindersDayName)).toEqual([
      'ב׳',
      'ג׳',
      'ד׳',
      'ה׳',
      'ו׳',
      'ש׳',
      'א׳',
    ]);
  });

  // A time like 06:00 is one run of digits and a colon, which the RTL layout can
  // reorder beside Hebrew; the isolate pins it left to right (see isolateLtr).
  it('isolates a time of day', () => {
    expect(strings.remindersTime('06:00')).toBe('\u206606:00\u2069');
  });
});

describe('targets (phase 53 D10, D11)', () => {
  // U+2066 ... U+2069 around every number, as vocabularyMark's: a run with no
  // strong direction is reordered by the RTL layout on Android.
  const ltr = (text: string) => '\u2066' + text + '\u2069';

  it('names the two kinds and writes a readiness percent', () => {
    expect(strings.targetKindName('homework')).toBe('שיעורי בית');
    expect(strings.targetKindName('exam')).toBe('בוחן');
    expect(strings.targetReadinessName(40)).toBe(ltr('40%'));
    // Phase 67 (spec D7): a ready word, from 90%, writes its percent as any other.
    expect(strings.targetReadinessName(89)).toBe(ltr('89%'));
    expect(strings.targetReadinessName(90)).toBe(ltr('90%'));
  });

  // Final review M2. My words with nothing of its own while targets hold every saved word.
  it('says every word is in the targets, by their kinds', () => {
    expect(strings.allWordsInTargets(['exam'])).toBe('כל המילים שלך כבר בהכנה לבוחן.');
    expect(strings.allWordsInTargets(['homework'])).toBe('כל המילים שלך כבר בהכנה לשיעורי הבית.');
    expect(strings.allWordsInTargets(['homework', 'exam'])).toBe('כל המילים שלך כבר בהכנה לבוחן ולשיעורי הבית.');
  });

  it('says how soon a target is, isolating the number', () => {
    expect(strings.targetTomorrow).toBe('מחר');
    expect(strings.targetInDays(5)).toBe('בעוד ' + ltr('5') + ' ימים');
    expect(strings.targetInDays(30)).toBe('בעוד ' + ltr('30') + ' ימים');
    expect(strings.targetDateCame).toBe('התאריך הגיע');
  });

  it('counts the ready words, isolating both numbers', () => {
    expect(strings.targetReadyCount(3, 8)).toBe(ltr('3') + ' מתוך ' + ltr('8') + ' מוכנות');
  });

  it('words a due date by its weekday, day and month, the day isolated', () => {
    // The weekday is JavaScript's, 0 for Sunday; the month is 1 for January.
    expect(strings.targetDueDay(5, 16, 10)).toBe('יום שישי, ' + ltr('16') + ' באוקטובר');
    expect([0, 1, 2, 3, 4, 5, 6].map((weekday) => strings.targetDueDay(weekday, 1, 1).split(',')[0])).toEqual([
      'יום ראשון',
      'יום שני',
      'יום שלישי',
      'יום רביעי',
      'יום חמישי',
      'יום שישי',
      'יום שבת',
    ]);
    const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(months.map((month) => strings.targetDueDay(0, 1, month).split(' ').pop())).toEqual([
      'בינואר',
      'בפברואר',
      'במרץ',
      'באפריל',
      'במאי',
      'ביוני',
      'ביולי',
      'באוגוסט',
      'בספטמבר',
      'באוקטובר',
      'בנובמבר',
      'בדצמבר',
    ]);
  });
});

describe('the target wizard and the target screen (phase 53 D10, D11)', () => {
  const ltr = (text: string) => '⁦' + text + '⁩';

  it('isolates every number it counts', () => {
    expect(strings.targetPhotosFull(10)).toBe('אפשר עד ' + ltr('10') + ' תמונות');
    expect(strings.targetUploading(2, 5)).toBe('שולחים תמונה ' + ltr('2') + ' מתוך ' + ltr('5') + '…');
    expect(strings.targetPhotosUnread(1, 3)).toBe('לא הצלחנו לקרוא ' + ltr('1') + ' מתוך ' + ltr('3') + ' תמונות');
    expect(strings.targetPickedCount(4)).toBe('מילים שנבחרו: ' + ltr('4'));
    expect(strings.targetEntriesFull(50)).toBe('אפשר עד ' + ltr('50') + ' מילים');
  });

  it('names the wizard of each action and each of its steps', () => {
    expect(strings.targetWizardAddPhotos).toBe('מילים מתמונות');
    expect(strings.targetWizardAddWords).toBe('הוספת מילים');
    expect(strings.targetWizardChangeDate).toBe('שינוי התאריך');
    expect(strings.targetStepChoose).toBe('מה לעשות עם המילים החדשות?');
    expect(strings.targetChooseMyWords).toBe('להוסיף למילים שלי');
    expect(strings.targetChooseNewExam).toBe('הכנה חדשה לבוחן');
    expect(strings.targetChooseNewHomework).toBe('הכנה חדשה לשיעורי בית');
    expect(strings.targetChooseExisting).toBe('או להוסיף להכנה קיימת');
    expect(strings.targetWordCount(1)).toBe('מילה אחת');
    expect(strings.targetWordCount(8)).toBe(ltr('8') + ' מילים');
    expect(strings.targetStepPhotos).toBe('תמונות של רשימת המילים');
    expect(strings.targetStepReview).toBe('המילים מהתמונות');
    expect(strings.targetStepWords).toBe('עוד מילים');
    expect(strings.targetStepDate).toBe('באיזה תאריך?');
    expect(strings.targetWizardNext).toBe('הבא');
    expect(strings.targetWizardDone).toBe('סיום');
  });

  it("says what Done's refusal asks the learner to fix", () => {
    expect(strings.targetNoWords).toBe('צריך לפחות מילה אחת. אפשר לחזור ולהוסיף מילים.');
    expect(strings.targetDueDatePast).toBe('צריך לבחור תאריך אחרי היום.');
    expect(strings.targetSaveFailed).toBe('השמירה נכשלה. נסו שוב.');
    expect(strings.targetClosed).toBe('ההכנה הזו כבר הסתיימה.');
  });

  it("words the target screen's actions and the end's question", () => {
    expect(strings.targetAddWord).toBe('הוספת מילה');
    expect(strings.targetChangeDate).toBe('שינוי התאריך');
    expect(strings.targetEnd).toBe('סיום ההכנה');
    expect(strings.targetEndTitle).toBe('לסיים את ההכנה?');
    expect(strings.targetEndMessage).toBe('המילים יישארו שמורות ברשימה שלך.');
    expect(strings.targetEndConfirm).toBe('סיום ההכנה');
  });
});

describe("home's cards (phase 57 D10, D11)", () => {
  const ltr = (text: string) => '⁦' + text + '⁩';
  const joined = (parts: { before: string; number: string | null; after: string }) =>
    parts.before + (parts.number ?? '') + parts.after;

  // Option B: the title is the countdown, its number apart so the card draws it large.
  it('counts down to the date with its number apart, and says tomorrow for one day', () => {
    expect(strings.targetCountdown('exam', 5)).toEqual({ before: 'בוחן בעוד ', number: ltr('5'), after: ' ימים' });
    expect(joined(strings.targetCountdown('exam', 5))).toBe('בוחן בעוד ' + ltr('5') + ' ימים');
    expect(joined(strings.targetCountdown('homework', 12))).toBe('שיעורי בית בעוד ' + ltr('12') + ' ימים');
    expect(strings.targetCountdown('homework', 1)).toEqual({ before: 'שיעורי בית מחר', number: null, after: '' });
    expect(joined(strings.targetCountdown('exam', 1))).toBe('בוחן מחר');
  });

  it('names the date itself once it has come (spec D10)', () => {
    expect(strings.targetDueToday('exam')).toBe('הבוחן היום');
    expect(strings.targetDueToday('homework')).toBe('שיעורי הבית היום');
    expect(joined(strings.targetCountdown('exam', 0))).toBe('הבוחן היום');
    expect(strings.targetCountdown('homework', -1)).toEqual({ before: 'שיעורי הבית היום', number: null, after: '' });
    expect(strings.targetGoodLuck).toBe('בהצלחה!');
    expect(strings.lastReview).toBe('חזרה אחרונה');
  });

  it("says today's sessions row for a screen reader, isolating each number (phase 65)", () => {
    expect(strings.targetSessionsSpoken(3, 5, 0)).toBe(ltr('3') + ' מתוך ' + ltr('5') + ' תרגולים היום');
    expect(strings.targetSessionsSpoken(5, 5, 2)).toBe(ltr('5') + ' מתוך ' + ltr('5') + ' תרגולים היום ועוד ' + ltr('2') + ' בונוס');
    expect(strings.targetSessionsMetSpoken).toBe('סיימת להיום');
  });

  it("words a counted skill's chance, the percent isolated (phase 65, spec D6)", () => {
    expect(strings.targetSkillChance(47)).toBe(ltr('47%'));
  });

  it("words the readiness for the target's kind, the percent isolated", () => {
    expect(strings.targetReadinessPct('exam', 18)).toBe('מוכנות לבוחן: ' + ltr('18%'));
    expect(strings.targetReadinessPct('homework', 100)).toBe('מוכנות לשיעורי הבית: ' + ltr('100%'));
  });

  it('words the buttons, the praise and the rest day', () => {
    expect(strings.practiceNow).toBe('לתרגל עכשיו');
    expect(strings.practiceMore).toBe('לתרגל עוד');
    expect(strings.targetRest('exam', 3)).toBe('היום אין תרגול לבוחן. התרגול הבא בעוד ' + ltr('3') + ' ימים');
    expect(strings.targetRest('homework', 2)).toBe('היום אין תרגול לשיעורי הבית. התרגול הבא בעוד ' + ltr('2') + ' ימים');
    expect(strings.targetRest('exam', 1)).toBe('היום אין תרגול לבוחן. התרגול הבא מחר');
    // No next practice day known: the first sentence alone.
    expect(strings.targetRest('exam', null)).toBe('היום אין תרגול לבוחן.');
  });

  it('titles My words and counts the words waiting for review', () => {
    expect(strings.myWords).toBe('המילים שלי');
    expect(strings.wordsWaiting(12)).toBe(ltr('12') + ' מילים מחכות לחזרה');
    expect(strings.wordsWaiting(0)).toBe(ltr('0') + ' מילים מחכות לחזרה');
    expect(strings.wordsWaiting(1)).toBe('מילה אחת מחכה לחזרה');
  });
});

describe('removing the words a filter shows (phase 58 D4, 58b R2)', () => {
  it("labels the icon, asks about the filter's words by name, and says when it failed", () => {
    expect(strings.vocabularyRemoveShown).toBe('הסרת המילים בסינון הזה');
    expect(strings.vocabularyRemoveTitle(null)).toBe('להסיר את כל המילים ברשימה?');
    expect(strings.vocabularyRemoveTitle(1)).toBe('להסיר את כל המילים ברמה "חדשה"?');
    expect(strings.vocabularyRemoveTitle(2)).toBe('להסיר את כל המילים ברמה "נחשפה"?');
    expect(strings.vocabularyRemoveMessage).toBe('המילים יוסרו מהרשימה ומהיעדים. אי אפשר לבטל.');
    expect(strings.vocabularyRemoveConfirm).toBe('הסרה');
    expect(strings.vocabularyRemoveFailed).toBe('ההסרה נכשלה. נסו שוב.');
  });
});

// Phase 62 (spec D7). Every sentence card says what is translated: the word, or the whole sentence.
describe('what to translate (phase 62 D7)', () => {
  it('names the word on the six word cards and the whole sentence on a translation', () => {
    expect(strings.questionInstruction).toBe('תרגמו את המילה לעברית');
    expect(strings.questionInstructionMeaning('he')).toEqual({ before: 'תרגמו את המילה ל', language: 'עברית', after: '' });
    expect(strings.newMeaningQuestion).toBe('מה עוד המילה אומרת?');
    expect(strings.questionInstructionReverse('it')).toBe('תרגמו את המילה לאיטלקית');
    expect(strings.questionInstructionTyped('it')).toEqual({ before: 'תרגמו את המילה ל', language: 'איטלקית', after: '' });
    expect(strings.questionInstructionSay('it')).toBe('אמרו את המילה באיטלקית');
    expect(strings.questionInstructionTranslate('it')).toEqual({ before: 'תרגמו את כל המשפט ל', language: 'איטלקית', after: '' });
  });
  it('labels the context line an example, and the whole sentence\'s translation once answered', () => {
    expect(strings.exampleLabel).toBe('משפט לדוגמה:');
    expect(strings.sentenceIn('he')).toBe('המשפט בעברית:');
    expect(strings.tapWordHint('he')).toBe('הקישו על מילה כדי לראות אותה בעברית');
  });
  it('leaves the gap cards as they were', () => {
    expect(strings.questionInstructionCloze).toBe('איזו מילה חסרה?');
    expect(strings.questionInstructionClozeTyped('it')).toEqual({ before: 'השלימו את המילה החסרה ב', language: 'איטלקית', after: '' });
  });
});

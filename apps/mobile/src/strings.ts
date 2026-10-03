// U+2066 LEFT-TO-RIGHT ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE.
//
// A label like "1 / 10" holds no strong directional character, so Android
// resolves its direction from the RTL layout and swaps the two numeric runs:
// it renders "10 / 1". The isolate pins the run to left-to-right on every
// platform. The `writingDirection` style cannot do this — React Native
// implements it on iOS only (it lives in TextStyleIOS), so it is a no-op on
// Android, which is exactly how this shipped broken the first time.
const isolateLtr = (text: string) => `\u2066${text}\u2069`;

const LANGUAGE_NAMES: Record<string, string> = { he: 'עברית', en: 'אנגלית', ru: 'רוסית' };
const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

export const strings = {
  appTitle: 'lang tutor',
  homeSubtitle: 'תרגול אוצר מילים',
  homeSetLabel: (count: number, language: string) => `${count} מילים ב${language}`,
  start: 'התחל',
  questionInstruction: 'מה הפירוש?',
  progressLabel: (position: number, total: number) => isolateLtr(`${position} / ${total}`),
  scoreLabel: (correct: number, total: number) => isolateLtr(`${correct} / ${total}`),
  continueLabel: 'המשך',
  feedbackCorrect: 'נכון!',
  feedbackWrong: 'התשובה הנכונה:',
  resultsHeadlineGreat: 'מצוין!',
  resultsHeadlineGood: 'עבודה טובה!',
  resultsHeadlineKeepPractising: 'ממשיכים לתרגל',
  resultsMissedTitle: 'כדאי לחזור על אלה',
  practiseAgain: 'תרגל שוב',
  done: 'סיום',
  errorTitle: 'משהו השתבש',
  errorMessage: 'נתחיל שוב מההתחלה',
  errorAction: 'אישור',
  loginTitle: 'כניסה',
  loginUsernameLabel: 'שם משתמש',
  loginAction: 'כניסה',
  loginUnknownUser: 'לא נמצא משתמש בשם הזה',
  loginFailed: 'הכניסה נכשלה, נסו שוב',
  newUserAction: 'משתמש חדש',
  usernameHint: 'אותיות אנגליות קטנות, ספרות וקו תחתון — בין 3 ל‑30 תווים',
  onboardingTitle: 'יצירת משתמש',
  onboardingNameLabel: 'שם',
  onboardingAgeLabel: 'גיל',
  onboardingNativeLabel: 'שפת אם',
  onboardingTargetLabel: 'שפה נלמדת',
  onboardingSubmit: 'יצירה',
  onboardingIncomplete: 'יש למלא את כל השדות',
  onboardingUsernameTaken: 'שם המשתמש כבר תפוס',
  onboardingRejected: 'אחד הפרטים אינו תקין',
  onboardingFailed: 'היצירה נכשלה, נסו שוב',
  languageName,
  learningLabel: (language: string) => `לומד/ת: ${language}`,
  addLanguage: 'הוספת שפה',
  enrollTitle: 'בחירת שפה ללימוד',
  enrollExplanation: 'ההסברים יהיו בעברית',
  enrollSubmit: 'התחלה',
  enrollFailed: 'ההרשמה נכשלה, נסו שוב',
  sessionNoQuestions: 'אין עדיין שאלות בשפה הזו',
  translateWrongDirection: (language: string) => `נראה שזו מילה ב${language}`,
  translateFlipRetry: 'החלף כיוון',
  translateOutOfPair: (language: string) => `זו לא מילה ב${language}`,
  profileTitle: 'הפרופיל שלי',
  profileNameLabel: 'שם',
  profileAgeLabel: 'גיל',
  switchUser: 'החלפת משתמש',
  back: 'חזרה',
  translateEntry: 'תרגום מלה או ביטוי',
  translateTitle: 'תרגום',
  translatePlaceholder: 'מלה או ביטוי…',
  translateAction: 'תרגם',
  translateDirection: (from: string, to: string) => `מ${languageName(from)} ל${languageName(to)}`,
  translateFlip: '⇄ החלף',
  translateTopSense: 'המשמעות הנפוצה',
  // Every sense is on screen, so this line is an orientation aid rather than a
  // control: it says how far the list goes before the learner starts scrolling.
  // Rendered only when there is more than one, because "1 משמעויות" is both
  // ungrammatical and pointless.
  translateSenseCount: (count: number) => `${count} משמעויות`,
  translateChoose: 'זו המשמעות שחיפשתי',
  translateChosen: 'התרגום נשמר לאוצר המילים שלך',
  translateNewWord: 'מלה חדשה',
  translateEmpty: 'לא מצאנו תרגום',
  translateUnavailable: 'התרגום לא זמין',
  translateRetry: 'נסה שוב',
  translateTooLong: 'עד 100 תווים',
  // U+2068 FSI and U+2069 PDI around each form. In the en_he direction this
  // banner embeds a Latin word inside a Hebrew RTL sentence, and without an
  // isolate the bidi algorithm reorders it against the wrong clause. The he_en
  // direction has no such problem, and one rule for both is cheaper than a
  // conditional.
  translateCorrectionNotice: (typed: string, corrected: string) =>
    `לא מצאנו את ⁨${typed}⁩ — מציגים תוצאות עבור ⁨${corrected}⁩`,
  translateDidYouMean: 'האם התכוונת ל:',
  // Known parts of speech only. An unfamiliar value returns undefined and the
  // screen omits the line, so a value the model invents tomorrow degrades to a
  // missing label rather than a broken card — the same reason the wire keeps
  // this field a plain string.
  partOfSpeech: (value: string): string | undefined =>
    ({
      noun: 'שם עצם',
      verb: 'פועל',
      adjective: 'שם תואר',
      adverb: 'תואר הפועל',
      preposition: 'מלת יחס',
      pronoun: 'כינוי גוף',
      conjunction: 'מלת חיבור',
      interjection: 'מלת קריאה',
      phrase: 'ביטוי',
    })[value.toLowerCase()],
} as const;

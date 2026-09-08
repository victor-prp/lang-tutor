// U+2066 LEFT-TO-RIGHT ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE.
//
// A label like "1 / 10" holds no strong directional character, so Android
// resolves its direction from the RTL layout and swaps the two numeric runs:
// it renders "10 / 1". The isolate pins the run to left-to-right on every
// platform. The `writingDirection` style cannot do this — React Native
// implements it on iOS only (it lives in TextStyleIOS), so it is a no-op on
// Android, which is exactly how this shipped broken the first time.
const isolateLtr = (text: string) => `\u2066${text}\u2069`;

export const strings = {
  appTitle: 'lang tutor',
  homeSubtitle: 'תרגול אוצר מילים',
  homeSetLabel: (count: number) => `${count} מילים באנגלית`,
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
  onboardingSameLanguage: 'שפת האם והשפה הנלמדת חייבות להיות שונות',
  onboardingUsernameTaken: 'שם המשתמש כבר תפוס',
  onboardingRejected: 'אחד הפרטים אינו תקין',
  onboardingFailed: 'היצירה נכשלה, נסו שוב',
  languageName: (code: string) => (code === 'he' ? 'עברית' : code === 'en' ? 'אנגלית' : code),
  profileTitle: 'הפרופיל שלי',
  profileNameLabel: 'שם',
  profileAgeLabel: 'גיל',
  switchUser: 'החלפת משתמש',
  back: 'חזרה',
  translateEntry: 'תרגום מלה או ביטוי',
  translateTitle: 'תרגום',
  translatePlaceholder: 'מלה או ביטוי…',
  translateAction: 'תרגם',
  translateDirection: (direction: string) =>
    direction === 'he_en' ? 'מעברית לאנגלית' : 'מאנגלית לעברית',
  translateFlip: '⇄ החלף',
  translateTopSense: 'המשמעות הנפוצה',
  translateMore: (count: number) => `עוד משמעויות (${count})`,
  translateChoose: 'זו המשמעות שחיפשתי',
  translateChosen: 'התרגום נשמר לאוצר המילים שלך',
  translateNewWord: 'מלה חדשה',
  translateEmpty: 'לא מצאנו תרגום',
  translateUnavailable: 'התרגום לא זמין',
  translateRetry: 'נסה שוב',
  translateTooLong: 'עד 100 תווים',
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

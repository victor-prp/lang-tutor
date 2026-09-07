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
} as const;

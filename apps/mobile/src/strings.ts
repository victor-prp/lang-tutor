import type { PartOfSpeech, TargetKind, UnavailableReason } from '@lang-tutor/core/api';
import type { Dimension, QuestionType } from '@lang-tutor/core/domain';

// U+2066 LEFT-TO-RIGHT ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE.
//
// A label like "1 / 10" holds no strong directional character, so Android
// resolves its direction from the RTL layout and swaps the two numeric runs:
// it renders "10 / 1". The isolate pins the run to left-to-right on every
// platform. The `writingDirection` style cannot do this — React Native
// implements it on iOS only (it lives in TextStyleIOS), so it is a no-op on
// Android, which is exactly how this shipped broken the first time.
const isolateLtr = (text: string) => `\u2066${text}\u2069`;

const LANGUAGE_NAMES: Record<string, string> = { he: 'עברית', en: 'אנגלית', ru: 'רוסית', it: 'איטלקית' };
const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

/** Phase 39 (spec D9). An instruction in three parts, so the card can set the language it asks for in bold. */
export type Instruction = { before: string; language: string; after: string };
const instruct = (before: string, language: string): Instruction => ({ before, language: languageName(language), after: '' });

// Phase 23. The direction of a string written in `code`, for a line whose
// language is known: Hebrew alone is right-to-left. Forcing rtl on a he → it
// lookup's Italian put an example's full stop at the start of its line.
const textDirection = (code: string): 'rtl' | 'ltr' => (code === 'he' ? 'rtl' : 'ltr');

// Phase 20. The five knowledge dimensions, as the word detail names them.
const DIMENSION_NAMES: Record<Dimension, string> = {
  written_receptive: 'זיהוי בכתב',
  written_productive: 'כתיבה',
  spoken_receptive: 'הבנת הנשמע',
  spoken_productive: 'דיבור',
  spelling: 'איות',
};

// Phase 21. A Record over the closed wire set, so the compiler refuses an
// eleventh part of speech that has no Hebrew name. `phrase` is not a code of
// PartOfSpeechSchema (kind records phrase-ness), so it is merged in below.
const PART_OF_SPEECH_NAMES: Record<PartOfSpeech, string> = {
  noun: 'שם עצם',
  verb: 'פועל',
  adjective: 'שם תואר',
  adverb: 'תואר הפועל',
  pronoun: 'כינוי גוף',
  preposition: 'מלת יחס',
  conjunction: 'מלת חיבור',
  determiner: 'מגדיר',
  interjection: 'מלת קריאה',
  numeral: 'שם מספר',
};
const PART_OF_SPEECH_LOOKUP: Record<string, string> = { ...PART_OF_SPEECH_NAMES, phrase: 'ביטוי' };

// Phase 52 (spec D8). The letter of the day, by ISO weekday 1 (Monday) to 7 (Sunday):
// Sunday is the first day (א׳) in Hebrew.
const REMINDER_DAY_NAMES = ['ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳', 'א׳'];

// Phase 53 (spec D4, D11). Records over the closed wire sets, so the compiler refuses
// a third kind that has no Hebrew name.
const TARGET_KIND_NAMES: Record<TargetKind, string> = { homework: 'שיעורי בית', exam: 'בוחן' };
// Phase 57 (spec D10, D11). The kind with its article, for the date itself ("הבוחן היום"),
// and with ל, for what the card's lines are about ("מוכנות לבוחן").
const TARGET_DUE_TODAY: Record<TargetKind, string> = { homework: 'שיעורי הבית היום', exam: 'הבוחן היום' };
const TARGET_FOR: Record<TargetKind, string> = { homework: 'לשיעורי הבית', exam: 'לבוחן' };
// Phase 64 (spec D5). The kind with its article, the subject of the "not ready" line.
const TARGET_THE: Record<TargetKind, string> = { homework: 'שיעורי הבית', exam: 'הבוחן' };

/** Phase 57 (spec D11, option B). A countdown title in three parts, so the card can draw
 *  the number large in the accent colour. `number` is null when the title has none. */
export type Countdown = { before: string; number: string | null; after: string };
const countdown = (kind: TargetKind, daysLeft: number): Countdown => {
  if (daysLeft < 1) return { before: TARGET_DUE_TODAY[kind], number: null, after: '' };
  if (daysLeft === 1) return { before: `${TARGET_KIND_NAMES[kind]} מחר`, number: null, after: '' };
  return { before: `${TARGET_KIND_NAMES[kind]} בעוד `, number: isolateLtr(String(daysLeft)), after: ' ימים' };
};
// The weekday as JavaScript numbers it, 0 (Sunday) to 6 (Saturday), and each month
// with its ב, which is how a date reads: "16 באוקטובר".
const TARGET_WEEKDAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const TARGET_MONTH_NAMES = [
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
];

// Phase 61 (spec D6). Each question type as a tester's screen names it.
const QUESTION_TYPE_NAMES: Record<QuestionType, string> = {
  meet: 'היכרות',
  multiple_choice: 'בחירת פירוש',
  new_meaning: 'פירוש חדש',
  typed_meaning: 'הקלדת פירוש',
  reverse_choice: 'בחירת מילה',
  cloze_choice: 'השלמה בבחירה',
  letter_tiles: 'אריחי אותיות',
  typed_translation: 'הקלדת מילה',
  cloze_typed: 'השלמה בהקלדה',
  sentence_translation: 'תרגום משפט',
  listen_choice: 'האזנה ובחירה',
  dictation: 'הכתבה',
  read_aloud: 'הקראה',
  say_translation: 'אמירת תרגום',
  matching: 'התאמה',
};

// Phase 61 (spec D2). Why the word cannot have a type, as the screen says it.
const UNAVAILABLE_REASONS: Record<UnavailableReason, string> = {
  no_voice: 'אין במכשיר קול לשפה',
  no_microphone: 'אי אפשר להקליט במכשיר',
  too_long: 'המילה ארוכה מדי לאמירה',
  no_tiles: 'המילה לא מתאימה לאריחים',
  no_example_gap: 'אין לפירוש הזה משפט לדוגמה להשלמה',
  no_other_meaning: 'אין למילה פירוש שמור נוסף',
  needs_more_words: 'צריך לפחות 7 מילים',
};

export const strings = {
  appTitle: 'lang tutor',
  homeSubtitle: 'תרגול אוצר מילים',
  homeSetLabel: (count: number, language: string) => `${count} מילים ב${language}`,
  start: 'התחל',
  resume: 'המשך',
  preparingQuestions: 'מכין שאלות…',
  skip: 'דלג',
  cancel: 'ביטול',
  skipConfirmTitle: 'לדלג על התרגול?',
  skipConfirmMessage: 'התרגול יסתיים, והתשובות שנתת בו לא ייספרו.',
  saveWordsFirst: 'כדי לתרגל, שמרו קודם מילים במסך התרגום.',
  // Final review M2. My words when every saved word is in an active target, which practises it:
  // the kinds that hold them, the exam's first.
  allWordsInTargets: (kinds: readonly TargetKind[]): string =>
    `כל המילים שלך כבר בהכנה ${(['exam', 'homework'] as const).filter((kind) => kinds.includes(kind)).map((kind) => TARGET_FOR[kind]).join(' ו')}.`,
  homeLoadFailed: 'טעינת התרגול נכשלה. אפשר לנסות שוב.',
  preparationFailed: 'יצירת השאלות נכשלה. אפשר לנסות שוב.',
  homeSavedLabel: (count: number, language: string) => `${count} משמעויות שמורות ב${language}`,
  // Phase 62 (spec D7): every sentence card says what is translated, the word or the whole sentence.
  questionInstruction: 'תרגמו את המילה לעברית',
  // Phase 39 (spec D6). A word the learner knows, asked for another meaning.
  questionInstructionNewMeaning: 'פירוש חדש למילה שאתם מכירים',
  knownMeanings: (meanings: readonly string[]) => `כבר למדתם: ${meanings.join(', ')}`,
  newMeaningQuestion: 'מה עוד המילה אומרת?',
  // Phase 23. The reversed and typed cards name the language they ask for.
  questionInstructionReverse: (language: string) => `תרגמו את המילה ל${languageName(language)}`,
  questionInstructionTyped: (language: string): Instruction => instruct('תרגמו את המילה ל', language),
  typedPlaceholder: 'התשובה שלך…',
  typedCheck: 'בדיקה',
  typedShowAnswer: 'הצגת התשובה',
  // Phase 24 (spec D14).
  questionInstructionListen: 'הקשיבו ובחרו את הפירוש',
  questionInstructionDictation: (language: string): Instruction => instruct('הקשיבו וכתבו ב', language),
  questionInstructionMatching: 'התאימו כל מילה לפירוש שלה',
  questionInstructionTiles: (language: string) => `הרכיבו את המילה ב${languageName(language)}`,
  listenAgain: 'השמעה חוזרת',
  listenNoVoice: 'אין במכשיר קול לשפה הזו, אז הנה המילה בכתב',
  boardResult: (right: number, total: number) => `בניסיון הראשון: ${right} מתוך ${total}`,
  // Phase 27 (spec D12).
  // Phase 39 (spec D9): names the learner's language, not always Hebrew.
  questionInstructionMeaning: (learner: string): Instruction => instruct('תרגמו את המילה ל', learner),
  // Phase 39 (spec D8). A typed answer in the wrong alphabet is asked again, not sent.
  wrongScriptNotice: (language: string): Instruction => instruct('התשובה צריכה להיות ב', language),
  feedbackSavedMeaning: 'נכון! הפירוש השמור:',
  feedbackOtherSense: 'נכון, אבל כאן תרגלנו:',
  // Phase 27 (spec D5, D6): the gap and translation cards.
  questionInstructionCloze: 'איזו מילה חסרה?',
  questionInstructionClozeTyped: (language: string): Instruction => instruct('השלימו את המילה החסרה ב', language),
  // Phase 38 (spec D1). The typed gap's Hebrew sentence is a hint, named by what it shows.
  sentenceHint: 'רמז: הצגת המשפט בעברית',
  // The whole sentence, by name: the marked word invited typing it alone.
  questionInstructionTranslate: (language: string): Instruction => instruct('תרגמו את כל המשפט ל', language),
  // One word on a translation card is asked again, not sent.
  wordOnlyNotice: 'כתבו את כל המשפט, לא רק את המילה',
  translationReference: 'תרגום לדוגמה:',
  // Phase 59c (design A). Under a translation card's sentence, while a tap can show a word.
  tapWordHint: (language: string) => `הקישו על מילה כדי לראות אותה ב${languageName(language)}`,
  // Phase 62 (spec D5, D7). Above a word card's context line, so it reads as an
  // example and not the thing to translate; and the line's whole translation once answered.
  exampleLabel: 'משפט לדוגמה:',
  sentenceIn: (language: string) => `המשפט ב${languageName(language)}:`,
  // Phase 54 (spec D1). The meet card: a new word, shown before it is asked.
  meetTitle: 'מילה חדשה',
  // Phase 55 (spec D7). Help on the tiles and typed cards, a tile that is not
  // the next letter, and the retype after a wrong typed answer (whose second
  // attempt says tryAgain).
  help: 'עזרה',
  tilesWrong: 'לא האות הזאת',
  retypeNotice: 'הקלידו את המילה שוב',
  // Phase 25 (spec D7).
  questionInstructionReadAloud: 'קראו בקול',
  questionInstructionSay: (language: string) => `אמרו את המילה ב${languageName(language)}`,
  record: 'הקלטה',
  recordingSecondsLeft: (seconds: number) => `מקליטים… ${seconds}`,
  checking: 'בודקים…',
  cantSpeak: 'אי אפשר לדבר עכשיו',
  noMicrophone: 'אין גישה למיקרופון',
  feedbackHeard: 'נכון! שמענו:',
  // FSI/PDI: a target-language transcript inside a Hebrew line.
  heardLine: (heard: string) => `שמענו: ⁨${heard}⁩`,
  notUnderstood: 'לא הבנו. שמענו:',
  heardNothing: 'לא שמענו כלום',
  couldNotCheck: 'לא הצלחנו לבדוק',
  tryAgain: 'נסו שוב',
  progressLabel: (position: number, total: number) => isolateLtr(`${position} / ${total}`),
  scoreLabel: (correct: number, total: number) => isolateLtr(`${correct} / ${total}`),
  continueLabel: 'המשך',
  feedbackCorrect: 'נכון!',
  feedbackWrong: 'התשובה הנכונה:',
  // Phase 23. Both count as correct (spec D9).
  feedbackNearMiss: 'כמעט! כך כותבים:',
  feedbackAlternative: 'נכון! המילה שתרגלנו:',
  // Phase 55 (spec D7). Right, with help: recorded wrong, so not green.
  feedbackHelped: 'נכון, עם עזרה',
  // Phase 45 (spec D1). Another accepted word again, on the second try: not "right".
  feedbackStillOther: 'עדיין לא המילה שתרגלנו:',
  feedbackStillOtherSense: 'עדיין לא הפירוש שתרגלנו:',
  // Phase 34 (spec D9). A card held for its second try: the first answer, then
  // what is left to find. FSI/PDI around the answer, as in heardLine: a target
  // word, or a whole sentence, inside a Hebrew line.
  retryRight: (answer: string) => `✓ נכון, ⁨${answer}⁩ מתאים כאן.`,
  retryAnotherWord: 'יש מילה נוספת ששמרת — נסו שוב',
  retryAnotherMeaning: 'יש פירוש נוסף — נסו שוב',
  // Phase 38 (spec D3). A typed gap's second try: the word fits, another was
  // meant, and the Hebrew sentence, now open, says which.
  retryMeantAnother: 'אבל התכוונו למילה אחרת — היעזרו במשפט בעברית ונסו שוב',
  resultsHeadlineGreat: 'מצוין!',
  resultsHeadlineGood: 'עבודה טובה!',
  resultsHeadlineKeepPractising: 'ממשיכים לתרגל',
  resultsMissedTitle: 'כדאי לחזור על אלה',
  nextSession: 'לתרגול הבא',
  done: 'סיום',
  errorTitle: 'משהו השתבש',
  errorMessage: 'נתחיל שוב מההתחלה',
  errorAction: 'אישור',
  signInTitle: 'כניסה',
  signInEmailLabel: 'כתובת מייל',
  signInSend: 'שליחת קוד',
  signInNewHere: 'חדשים כאן? אותו קוד גם פותח חשבון.',
  signInCodeTitle: 'הקלדת הקוד',
  signInSentTo: (email: string) => `שלחנו קוד ל-${email}. כדאי לבדוק גם בספאם.`,
  signInCodeLabel: 'קוד בן 8 ספרות',
  signInSubmit: 'כניסה',
  signInResend: 'שליחת קוד חדש',
  signInResendIn: (seconds: number) => `אפשר לשלוח קוד חדש בעוד ${seconds} שניות`,
  signInOtherEmail: 'כתובת מייל אחרת',
  signInProblem: {
    wrong_code: 'הקוד לא נכון. אפשר לנסות שוב.',
    new_code_needed: 'הקוד כבר לא בתוקף. צריך לשלוח קוד חדש.',
    too_many_codes: 'נשלחו יותר מדי קודים לכתובת הזו. אפשר לנסות שוב בעוד שעה.',
    email_not_sent: 'לא הצלחנו לשלוח את המייל. אפשר לנסות שוב.',
    invalid_email: 'כתובת המייל לא תקינה.',
    server_error: 'משהו השתבש. אפשר לנסות שוב.',
    network: 'אין חיבור לשרת. אפשר לנסות שוב.',
  },
  offlineTitle: 'אין חיבור לשרת',
  offlineRetry: 'לנסות שוב',
  signOut: 'יציאה',
  profileUsernameLabel: 'שם משתמש',
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
  textDirection,
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
  // Phase 32 (spec D9, D10). The update-required screen, and the version row.
  appVersionLabel: 'גרסה',
  updateChecking: 'בודקים אם יש גרסה חדשה…',
  updateRequiredTitle: 'יש גרסה חדשה',
  updateRequiredBody: 'הגרסה הזו של האפליקציה כבר לא עובדת מול השרת. צריך לעדכן אותה כדי להמשיך.',
  updateRequiredButton: 'לעדכון ב‑Google Play',
  updateRequiredButtonIos: 'לעדכון ב‑TestFlight',
  updateCheckAgain: 'לבדוק שוב',
  // Phase 49 (spec D4, R4). The About screen; its three labels stay English.
  aboutTitle: 'אודות',
  aboutCopy: 'העתקה',
  aboutCopied: 'הועתק',
  back: 'חזרה',
  // Phase 52 (spec D8). The Reminders screen.
  remindersEntry: 'תזכורות',
  remindersTitle: 'תזכורות',
  remindersEnabled: 'תזכורות לתרגול',
  remindersTargetLabel: 'תרגולים ביום',
  remindersTargetLess: 'פחות תרגולים',
  remindersTargetMore: 'יותר תרגולים',
  remindersDaysLabel: 'ימים',
  remindersTimesLabel: 'שעות',
  /** `day` is an ISO weekday: 1 = Monday ... 7 = Sunday. */
  remindersDayName: (day: number): string => REMINDER_DAY_NAMES[day - 1] ?? String(day),
  /** A time of day, `06:00`, pinned left to right beside the Hebrew around it. */
  remindersTime: (time: string): string => isolateLtr(time),
  remindersDeniedNotice: 'התזכורות כבויות בהגדרות של אנדרואיד.',
  remindersOpenSettings: 'לפתיחת ההגדרות',
  remindersEnable: 'הפעלת התראות',
  remindersWebNotice: 'התזכורות מגיעות לאפליקציה באנדרואיד.',
  remindersLoadFailed: 'טעינת התזכורות נכשלה. אפשר לנסות שוב.',
  remindersSaveFailed: 'שמירת התזכורות נכשלה. אפשר לנסות שוב.',
  // Phase 23. The speaker button's accessibility label.
  speak: 'השמעה',
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
  // Phase 18. The card's own toggle states the save, truthfully — which closes the
  // caveat phase 10 carried on `התרגום נשמר לאוצר המילים שלך`, now deleted.
  translateSave: 'שמור',
  translateSaved: 'נשמר ✓',
  translateSaveAll: 'שמור הכל',
  translateSaveFailed: 'השמירה נכשלה, נסו שוב',
  translateNewWord: 'מלה חדשה',
  translateEmpty: 'לא מצאנו תרגום',
  translateUnavailable: 'התרגום לא זמין',
  translateRetry: 'נסה שוב',
  translateTooLong: 'עד 100 תווים',
  vocabularyEntry: 'אוצר המילים שלי',
  vocabularyTitle: (language: string) => `אוצר המילים שלי ב${languageName(language)}`,
  vocabularyEmpty: 'עוד לא שמרת מילים. חפשו מילה בתרגום ולחצו על שמור.',
  vocabularyGoTranslate: 'לתרגום',
  vocabularyLoadFailed: 'הרשימה לא נטענה',
  // "2/5": saved of total. Isolated for the reason progressLabel is: a run with
  // no strong direction is reordered by the RTL layout on Android.
  vocabularyMark: (saved: number, total: number) => isolateLtr(`${saved}/${total}`),
  // Phase 31 (spec D5). The gloss's other target words, under its headline.
  also: (words: readonly string[]) => `גם: ${words.join(', ')}`,
  // Phase 31 (spec D11). The form a word was saved from, when it is not the lemma.
  // FSI/PDI around the form, as in translateCorrectionNotice: a Cyrillic or Latin
  // word inside a Hebrew sentence.
  savedFrom: (form: string, translation: string) => `נשמר מתוך ⁨${form}⁩: ${translation}`,
  // U+2068 FSI and U+2069 PDI around each form. In the en_he direction this
  // banner embeds a Latin word inside a Hebrew RTL sentence, and without an
  // isolate the bidi algorithm reorders it against the wrong clause. The he_en
  // direction has no such problem, and one rule for both is cheaper than a
  // conditional.
  translateCorrectionNotice: (typed: string, corrected: string) =>
    `לא מצאנו את ⁨${typed}⁩ — מציגים תוצאות עבור ⁨${corrected}⁩`,
  translateDidYouMean: 'האם התכוונת ל:',
  // Phase 20. Five levels, feminine to agree with מילה (spec §5).
  levelName: (level: number): string => ['חדשה', 'נחשפה', 'מוכרת', 'ידועה', 'בשליטה'][level - 1] ?? '',
  levelAll: 'הכל',
  levelRaised: (level: number) => `עלתה לרמה ${level}`,
  // Phase 23 (spec D11). A dimension rose and the badge did not.
  dimensionsRaised: (dimensions: Dimension[]) =>
    `התקדמות: ${dimensions.map((dimension) => DIMENSION_NAMES[dimension]).join(', ')}`,
  dimensionName: (dimension: Dimension): string => DIMENSION_NAMES[dimension],
  notPractised: 'טרם תורגל',
  vocabularyEmptyLevel: 'אין מילים ברמה הזו',
  // Phase 58 (spec D4), 58b (R2). The trash icon on every filter, read aloud by a
  // screen reader, and the question before it, naming the filter's words.
  vocabularyRemoveShown: 'הסרת המילים בסינון הזה',
  vocabularyRemoveTitle: (level: number | null): string =>
    level === null ? 'להסיר את כל המילים ברשימה?' : `להסיר את כל המילים ברמה "${strings.levelName(level)}"?`,
  vocabularyRemoveMessage: 'המילים יוסרו מהרשימה ומהיעדים. אי אפשר לבטל.',
  vocabularyRemoveConfirm: 'הסרה',
  vocabularyRemoveFailed: 'ההסרה נכשלה. נסו שוב.',
  resultsPractisedTitle: 'המילים שתרגלת',
  // Known parts of speech only. An unfamiliar value returns undefined and the
  // screen omits the line, so a value the model invents tomorrow degrades to a
  // missing label rather than a broken card — the same reason the wire keeps
  // this field a plain string.
  partOfSpeech: (value: string): string | undefined => {
    const key = value.toLowerCase();
    return Object.hasOwn(PART_OF_SPEECH_LOOKUP, key) ? PART_OF_SPEECH_LOOKUP[key] : undefined;
  },
  // Phase 28. Tutors and students. Usernames are Latin inside Hebrew sentences,
  // so they sit in FSI/PDI isolates, as translateCorrectionNotice's forms do.
  enrollTeach: 'אני כאן כדי ללמד',
  startLearning: 'התחלת לימוד שפה',
  inviteCard: (tutor: string, language: string) =>
    `${tutor} רוצה להוסיף מילים לרשימת ה${languageName(language)} שלך`,
  inviteAccept: 'אישור',
  inviteDecline: 'דחייה',
  studentsTitle: 'התלמידים שלי',
  personAndLanguage: (name: string, language: string) => `${name} · ${languageName(language)}`,
  studentPending: (name: string) => `ממתין לאישור של ${name}`,
  inviteStudent: 'הזמנת תלמיד/ה',
  inviteUsernameLabel: 'שם המשתמש של התלמיד/ה',
  inviteLanguageLabel: 'השפה שאת/ה מלמד/ת',
  inviteSubmit: 'שליחת הזמנה',
  inviteUserNotFound: 'אין משתמש בשם הזה',
  inviteNotLearning: (username: string, language: string) =>
    `⁨${username}⁩ עדיין לא לומד/ת ${languageName(language)} כאן`,
  inviteOwnList: 'אי אפשר להזמין את עצמך',
  inviteExists: 'כבר הזמנת את התלמיד/ה הזה/ו בשפה הזו',
  inviteFailed: 'ההזמנה נכשלה, נסו שוב',
  cancelInviteTitle: 'לבטל את ההזמנה?',
  cancelInviteMessage: (name: string) => `${name} לא יוכל/תוכל לאשר אותה.`,
  cancelInviteConfirm: 'ביטול ההזמנה',
  studentWordsTitle: (name: string, language: string) => `הוספת מילים ל${name} · ${languageName(language)}`,
  stopTutoring: (name: string) => `הפסקת הלימוד עם ${name}`,
  stopTutoringFailed: 'הפעולה נכשלה, נסו שוב',
  stopTutoringTitle: 'להפסיק ללמד?',
  stopTutoringMessage: (name: string) =>
    `לא תוכל/י יותר להוסיף מילים לרשימה של ${name}. המילים שכבר הוספת יישארו.`,
  tutorsTitle: 'המורים שלי',
  endTutor: 'סיום',
  endTutorTitle: 'לסיים עם המורה?',
  endTutorMessage: (name: string) =>
    `${name} לא יוכל/תוכל יותר להוסיף מילים לרשימה שלך. המילים שכבר נוספו יישארו.`,
  teachingTitle: 'הוראה',
  tutorAdd: 'הוספה',
  tutorAdded: 'נוסף ✓',
  tutorAddAll: 'הוספת הכל',
  addedBy: (names: string[]) => `נוספה ע״י ${names.join(', ')}`,
  noneYet: '—',
  // Phase 26. Words from a photo.
  photoImportEntry: 'מילים מתמונה',
  photoImportTitle: 'מילים מתמונה',
  photoImportTake: 'צילום רשימה',
  photoImportChoose: 'בחירה מהגלריה',
  photoImportOpenTitle: 'רשימות פתוחות',
  photoImportDenied: 'אין הרשאה למצלמה או לגלריה. אפשר לאשר אותה בהגדרות.',
  photoImportUploadFailed: 'שליחת התמונה נכשלה. נסו שוב.',
  photoImportReading: 'קוראים את התמונה…',
  photoImportLookingUp: (done: number, total: number) => `מחפשים מילים: ${isolateLtr(`${done}/${total}`)}`,
  photoImportReady: 'מוכן לסקירה',
  photoImportWordCount: (count: number) => `${isolateLtr(String(count))} מילים`,
  photoImportFailed: 'לא הצלחנו לקרוא את התמונה',
  photoImportNoWords: (language: string) => `לא נמצאו מילים ב${language} בתמונה`,
  photoImportReadAs: (text: string) => `נקרא כ: ${text}`,
  photoImportListSays: (hebrew: string) => `ברשימה כתוב: ${hebrew}`,
  photoImportReasonSentence: 'משפט שלם — אי אפשר לשמור',
  photoImportReasonNoMeaning: 'לא נמצאה משמעות',
  photoImportReasonNotInLanguage: 'לא בשפה הנלמדת',
  photoImportRowFailed: 'החיפוש נכשל',
  photoImportPending: 'מחפשים…',
  photoImportSave: (count: number) => `שמירת ${isolateLtr(String(count))} מילים`,
  photoImportSaveFailed: 'השמירה נכשלה. נסו שוב.',
  photoImportDiscard: 'ביטול הרשימה',
  photoImportDiscardTitle: 'לבטל את הרשימה?',
  photoImportDiscardMessage: 'המילים שבה לא יישמרו.',
  photoImportDiscardConfirm: 'ביטול הרשימה',
  photoImportDiscardCancel: 'חזרה',
  photoImportSaved: (count: number) => `${isolateLtr(String(count))} מילים נשמרו`,
  homePhotoWorking: 'קוראים את התמונה שלך…',
  homePhotoReady: (count: number) => `רשימה מתמונה: ${isolateLtr(String(count))} מילים לסקירה`,
  homePhotoFailed: 'לא הצלחנו לקרוא את התמונה ששלחת',
  homePhotoSeveral: (count: number) => `${isolateLtr(String(count))} רשימות מתמונות מחכות לסקירה`,
  // Phase 53 (spec D10, D11). Preparing for homework or a test.
  targetKindName: (kind: TargetKind): string => TARGET_KIND_NAMES[kind],
  // Phase 57 (spec D9, D12). A word's readiness is a percent, and "ready" at 100%.
  targetReadinessName: (readinessPct: number): string => (readinessPct >= 100 ? 'מוכנה' : isolateLtr(`${readinessPct}%`)),
  targetTomorrow: 'מחר',
  targetInDays: (days: number) => `בעוד ${isolateLtr(String(days))} ימים`,
  // A target read after its date has come is no longer counted down to.
  targetDateCame: 'התאריך הגיע',
  targetReadyCount: (ready: number, total: number) =>
    `${isolateLtr(String(ready))} מתוך ${isolateLtr(String(total))} מוכנות`,
  /** `weekday` is JavaScript's (0 = Sunday), `month` is 1 = January. */
  targetDueDay: (weekday: number, day: number, month: number) =>
    `יום ${TARGET_WEEKDAY_NAMES[weekday]}, ${isolateLtr(String(day))} ${TARGET_MONTH_NAMES[month - 1]}`,
  // The wizard: its title for each action, and each step's (spec D10).
  targetWizardAddPhotos: 'מילים מתמונות',
  targetWizardAddWords: 'הוספת מילים',
  targetWizardChangeDate: 'שינוי התאריך',
  // Phase 64 (spec D8). The photo flow's choice, once the words are marked.
  targetStepChoose: 'מה לעשות עם המילים החדשות?',
  targetChooseMyWords: 'להוסיף למילים שלי',
  targetChooseNewExam: 'הכנה חדשה לבוחן',
  targetChooseNewHomework: 'הכנה חדשה לשיעורי בית',
  targetChooseExisting: 'או להוסיף להכנה קיימת',
  targetWordCount: (count: number) => (count === 1 ? 'מילה אחת' : `${isolateLtr(String(count))} מילים`),
  targetStepPhotos: 'תמונות של רשימת המילים',
  targetStepReview: 'המילים מהתמונות',
  targetStepWords: 'עוד מילים',
  targetStepDate: 'באיזה תאריך?',
  // A target screen's add photos, whose Next needs a photo: no skipping there.
  targetPhotosHintAdd: 'אפשר לצלם או לבחור כמה תמונות.',
  targetReviewHint: 'אפשר להוריד סימון ממילה או לבחור לה משמעות אחרת.',
  targetWordsHint: 'חפשו מילה והוסיפו אותה לרשימה.',
  targetWizardNext: 'הבא',
  targetWizardDone: 'סיום',
  // Leaving the wizard with photos or words picked: nothing was saved yet.
  targetLeaveTitle: 'לצאת בלי לשמור?',
  targetLeaveMessage: 'התמונות והמילים שנבחרו לא יישמרו.',
  targetLeaveConfirm: 'יציאה',
  targetPhotoRemove: 'הסרת התמונה',
  targetPhotosFull: (max: number) => `אפשר עד ${isolateLtr(String(max))} תמונות`,
  // While the chosen photos are shrunk, one at a time, before they are shown.
  targetPhotosPreparing: 'מכינים את התמונות…',
  // `current` is the photo on its way, counted from 1.
  targetUploading: (current: number, total: number) =>
    `שולחים תמונה ${isolateLtr(String(current))} מתוך ${isolateLtr(String(total))}…`,
  targetPhotoAddFailed: 'לא הצלחנו להוסיף את התמונה. נסו שוב.',
  targetPhotoRemoveFailed: 'הסרת התמונה נכשלה. נסו שוב.',
  targetReviewReading: 'קוראים את התמונות…',
  targetReviewLoadFailed: 'טעינת המילים נכשלה. מנסים שוב…',
  targetReviewEmpty: 'לא נמצאו מילים בתמונות.',
  // Ruling R-D9: each photo is its own import, and a failed one is a photo not read.
  targetPhotosUnread: (unread: number, total: number) =>
    `לא הצלחנו לקרוא ${isolateLtr(String(unread))} מתוך ${isolateLtr(String(total))} תמונות`,
  targetPickedCount: (count: number) => `מילים שנבחרו: ${isolateLtr(String(count))}`,
  targetEntriesFull: (max: number) => `אפשר עד ${isolateLtr(String(max))} מילים`,
  targetEntryRemove: 'הסרה',
  targetDatesLoadFailed: 'טעינת התאריכים נכשלה.',
  // Done refused: what to fix (the 400's reason), or that it did not go through.
  targetNoWords: 'צריך לפחות מילה אחת. אפשר לחזור ולהוסיף מילים.',
  targetDueDatePast: 'צריך לבחור תאריך אחרי היום.',
  targetSaveFailed: 'השמירה נכשלה. נסו שוב.',
  targetClosed: 'ההכנה הזו כבר הסתיימה.',
  // The target screen (spec D11).
  targetAddWord: 'הוספת מילה',
  targetChangeDate: 'שינוי התאריך',
  targetEnd: 'סיום ההכנה',
  targetEndTitle: 'לסיים את ההכנה?',
  targetEndMessage: 'המילים יישארו שמורות ברשימה שלך.',
  targetEndConfirm: 'סיום ההכנה',
  targetWordRemove: 'הסרה',
  targetEmpty: 'אין מילים בהכנה הזו.',
  targetLoadFailed: 'טעינת ההכנה נכשלה. אפשר לנסות שוב.',
  targetActionFailed: 'הפעולה נכשלה. נסו שוב.',
  // Phase 57 (spec D10, D11). Home's cards: a target's countdown, its day and readiness,
  // and the My words card.
  targetCountdown: (kind: TargetKind, daysLeft: number): Countdown => countdown(kind, daysLeft),
  targetDueToday: (kind: TargetKind): string => TARGET_DUE_TODAY[kind],
  targetGoodLuck: 'בהצלחה!',
  lastReview: 'חזרה אחרונה',
  targetToday: (done: number, planned: number) =>
    `היום: ${isolateLtr(String(done))} מתוך ${isolateLtr(String(planned))} מילים`,
  // After today's line once every planned word is done.
  targetTodayCheck: '✓',
  // The words started early today, after the check (extra-words.html).
  targetExtra: (count: number) => `${isolateLtr(`+${count}`)} נוספות`,
  // The target screen's word groups and each word's line for today (spec D12).
  targetGroupTitle: { owed: 'נשאר להיום', done: 'סיימת להיום', extra: 'נוספו היום', later: 'בהמשך' } as const,
  targetWordOwed: (names: string[]) => `היום נשאר: ${names.join(', ')}`,
  targetWordDone: 'היום ✓',
  targetWordExtra: 'בונוס ✓',
  targetWordStartsIn: (days: number) =>
    days === 1 ? 'נתחיל מחר' : `נתחיל בעוד ${isolateLtr(String(days))} ימים`,
  targetReadinessPct: (kind: TargetKind, pct: number) => `מוכנות ${TARGET_FOR[kind]}: ${isolateLtr(`${pct}%`)}`,
  practiceNow: 'לתרגל עכשיו',
  // Phase 64 (spec D4, D5). The card's blue header: the countdown's big line, the fuse's label
  // in the last two days, the "not ready" line and the line once every word is ready.
  countdownDays: 'ימים',
  countdownNumber: (days: number) => isolateLtr(String(days)),
  /** My words' big number. */
  countNumber: (count: number) => isolateLtr(String(count)),
  countdownTomorrow: 'מחר',
  countdownToday: 'היום',
  fuseLabel: 'הזמן שנשאר',
  fuseOneDay: 'יום אחד',
  fuseToday: 'היום',
  /** `daysLeft` is 1 (tomorrow) or 0 (the date itself); `missing` the words not ready, at least 1. */
  targetNotReady: (kind: TargetKind, daysLeft: number, missing: number): string => {
    const day = daysLeft < 1 ? 'היום' : 'מחר';
    const words = missing === 1 ? 'ומילה אחת עוד לא מוכנה' : `ו-${isolateLtr(String(missing))} מילים עוד לא מוכנות`;
    const help = daysLeft < 1 ? 'חזרה אחרונה תעזור.' : 'עוד תרגול אחד יעזור.';
    return `${TARGET_THE[kind]} ${day} ${words}. ${help}`;
  },
  targetAllReady: (kind: TargetKind): string => `כל המילים מוכנות ${TARGET_FOR[kind]} ✓`,
  // My words' header: the number, and what it counts.
  myWordsDue: (count: number) => (count === 1 ? 'מילה מחכה לחזרה' : 'מילים מחכות לחזרה'),
  myWordsSeed: (language: string) => `מילים ב${language}`,
  myWordsSaved: (language: string) => `משמעויות שמורות ב${language}`,
  practiceMore: 'לתרגל עוד',
  targetDonePraise: 'כל הכבוד! סיימת להיום. נתראה מחר',
  /** A rest day. `nextIn` is the days to the next practice day, null when none is known. */
  targetRest: (kind: TargetKind, nextIn: number | null): string => {
    const today = `היום אין תרגול ${TARGET_FOR[kind]}.`;
    if (nextIn === null) return today;
    return nextIn === 1
      ? `${today} התרגול הבא מחר`
      : `${today} התרגול הבא בעוד ${isolateLtr(String(nextIn))} ימים`;
  },
  myWords: 'המילים שלי',
  // Phase 64 (spec D1, D7). The bar's four tabs, and the groups of אני and הגדרות.
  tabPractice: 'תרגול',
  tabWords: 'מילים',
  tabMe: 'אני',
  tabSettings: 'הגדרות',
  settingsTitle: 'הגדרות',
  myLanguagesTitle: 'השפות שלי',
  wordsWaiting: (count: number) =>
    count === 1 ? 'מילה אחת מחכה לחזרה' : `${isolateLtr(String(count))} מילים מחכות לחזרה`,
  // Phase 61 (spec D6). A tester's session of one meaning's question types.
  questionTypesLink: 'בדיקת סוגי שאלות',
  questionTypesTitle: 'סוגי שאלות',
  questionTypesStart: 'התחלה',
  questionTypesPreparing: 'מכינים את השאלות…',
  questionTypesLoadFailed: 'הטעינה נכשלה. אפשר לנסות שוב.',
  questionTypesNoneChosen: 'בחרו לפחות סוג שאלה אחד.',
  questionTypesFailed: 'לא נוצרה אף שאלה.',
  questionTypesSkipped: 'לא נוצרו שאלות מהסוגים:',
  questionTypesContinue: 'המשך לתרגול',
  questionTypesSessionOpen: 'יש תרגול פתוח. סיימו אותו קודם.',
  questionTypesSeedPending: 'סיימו קודם את התרגול הראשון.',
  questionTypesStartFailed: 'ההתחלה נכשלה. נסו שוב.',
  questionTypeName: (type: QuestionType): string => QUESTION_TYPE_NAMES[type],
  questionTypeUnavailable: (reason: UnavailableReason): string => UNAVAILABLE_REASONS[reason],
} as const;

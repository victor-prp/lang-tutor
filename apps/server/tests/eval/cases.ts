import type { LanguageCode, PartOfSpeech, TranslationKind } from '@lang-tutor/core/api';

import type { Task } from '../../src/domain/distractors';
import type { StoredSense } from '../../src/domain/translation';

/**
 * Each case stresses one property of the prompt. `acceptTop` is a *set*, not a
 * string: a rewording must not fail a case, only a wrong meaning should.
 */
export type EvalCase = {
  label: string;
  text: string;
  /** Defaults to en → he. */
  from?: LanguageCode;
  to?: LanguageCode;
  expectKind: TranslationKind;
  /** Accepted values for the highest-ranked sense. Empty when expectEmpty. */
  acceptTop: string[];
  /** Must appear as some sense's translation, in any position. */
  expectAlso?: string[];
  /** Must appear nowhere — a literal rendering of an idiom, for instance. */
  rejectAny?: string[];
  expectEmpty?: boolean;
  /** Exactly this many entries. `saw` is 2 — the failure the entries model replaced. */
  expectEntries?: number;
  /** At least this many senses on the first entry. */
  expectEntrySenses?: number;
  /** The lemma the first entry must resolve to. `running` is `run`. */
  expectLemma?: string;
  /** Every entry's part_of_speech must be one of these. `booked` is a verb form,
   *  so a noun entry is the reading defect returning. */
  expectEntryPos?: string[];
  /** Exactly these parts of speech, in this order, one entry each. */
  expectPosOrder?: string[];
  /** The top translation must NOT be any of these — the rendering defect:
   *  `booked` answering with an infinitive rather than a past tense. */
  rejectTop?: string[];
  /** The lemma each named part of speech must resolve to. `expectLemma` reads
   *  entries[0], which for an inflected form is usually the verb; this reaches
   *  the entry that actually matters. Phase 12 follow-up: `burnt` and `burned` are one
   *  adjective, and must name one lemma. */
  expectLemmaFor?: Record<string, string>;
  /** No sense's example may contain any of these. A regression lock on a
   *  specific known-bad sentence, exactly as `rejectTop` is on a known-bad
   *  translation — NOT a general claim that every other example is good.
   *  Whether an example demonstrates its sense is a judgement, read off the
   *  scorecard; what is mechanical is that a sentence we have already seen fail
   *  does not come back. */
  rejectExample?: string[];
  /** Phase 13. The corrected_form the model must report, matched
   *  case-insensitively. */
  expectCorrection?: string;
  /** Must appear somewhere in `correction.alternatives`. */
  expectAlternative?: string;
  /** No correction at all. The inflection trap, and the most important assertion
   *  in the set: `lemma ≠ typed form` is true of an inflection AND of a typo, so
   *  a model that starts "correcting" real forms writes permanent redirects away
   *  from correctly spelled words. */
  expectNoCorrection?: true;
};

export const CASES: EvalCase[] = [
  // Inverted by phase 12. This case used to assert `book` was ONE entry whose
  // senses spanned two parts of speech — the shape that made `booked` inherit
  // the noun's senses in the infinitive. It is now the worked example of two.
  {
    label: 'one lemma, two parts of speech, two entries',
    text: 'book',
    expectKind: 'word',
    acceptTop: ['ספר'],
    expectAlso: ['להזמין', 'הזמנה', 'לשריין'],
    expectEntries: 2,
    expectPosOrder: ['noun', 'verb'],
  },
  // Both halves of the reported defect in one case: `rejectAny: ['ספר']` is the
  // reading — an inflected verb form must never reach the noun's senses — and
  // `rejectTop: ['להזמין']` is the rendering: a past-tense input must not answer
  // with an infinitive.
  {
    label: 'an inflected form: its own part of speech, in its own tense',
    text: 'booked',
    expectKind: 'word',
    acceptTop: ['הזמין', 'תפוס'],
    rejectAny: ['ספר'],
    rejectTop: ['להזמין'],
    expectEntryPos: ['verb', 'adjective'],
    // Phase 13. The inflection trap. A model that calls `booked` a misspelling of
    // `book` writes a redirect that never expires — partially self-limiting, since
    // the redirect is consulted only AFTER the by-form read misses, so once
    // `booked` is legitimately written the bad row is shadowed and inert. It bites
    // for a form never looked up correctly first. These three are the cases to
    // watch when a model version changes.
    expectNoCorrection: true,
  },
  {
    label: 'ranking: a homonym with an unrelated second sense',
    text: 'bank',
    expectKind: 'word',
    acceptTop: ['בנק'],
    expectAlso: ['גדה', 'גדת הנהר', 'שפה'],
  },
  // Three parts of speech of one lemma, which is why the entry cap went 3 -> 6.
  {
    label: 'three parts of speech of one lemma, under the raised cap',
    text: 'light',
    expectKind: 'word',
    acceptTop: ['אור'],
    expectAlso: ['קל', 'בהיר', 'להדליק'],
    expectEntries: 3,
  },
  {
    label: 'an idiom translated by meaning, and classified phrase despite being imperative',
    text: 'break a leg',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה', 'שיהיה בהצלחה'],
    rejectAny: ['לשבור רגל', 'שבור רגל'],
  },
  {
    label: 'a non-imperative fixed expression',
    text: 'point of view',
    expectKind: 'phrase',
    acceptTop: ['נקודת מבט', 'השקפה'],
  },
  // `expectEntries` is deliberately absent here and on `saw` below. Phase 12
  // splits entries by part of speech as well as by headword, so the entry COUNT
  // of an inflected form is no longer a stable property: `running` is the verb
  // `run`, the noun `run` and arguably an adjective, and all three are correct.
  // What still holds — and is what this case was ever really about — is that the
  // form resolves to its headword rather than to itself.
  {
    label: 'an inflected form still resolves to its headword',
    text: 'running',
    expectKind: 'word',
    acceptTop: ['ריצה', 'לרוץ', 'רץ'],
    expectLemma: 'run',
    // Phase 13. The inflection trap. A model that calls `booked` a misspelling of
    // `book` writes a redirect that never expires — partially self-limiting, since
    // the redirect is consulted only AFTER the by-form read misses, so once
    // `booked` is legitimately written the bad row is shadowed and inert. It bites
    // for a form never looked up correctly first. These three are the cases to
    // watch when a model version changes.
    expectNoCorrection: true,
  },
  {
    label: 'the reverse direction',
    text: 'מזלג',
    from: 'he',
    to: 'en',
    expectKind: 'word',
    acceptTop: ['fork'],
  },
  {
    label: 'a sentence: classified as one, and exactly one sense',
    text: "I'm looking forward to seeing you",
    expectKind: 'sentence',
    acceptTop: ['אני מצפה לראות אותך', 'אני מחכה לראות אותך'],
  },
  {
    label: 'register: slang against temperature',
    text: 'cool',
    expectKind: 'word',
    acceptTop: ['מגניב', 'קריר', 'נחמד'],
    expectAlso: ['קריר', 'צונן', 'מגניב'],
  },
  // Two headwords, and since phase 12 three lexemes: the verb `see`, the noun
  // `saw` (the tool) and the verb `saw` (to cut). The count is not asserted for
  // the reason given on `running`; that both headwords are reached is, by
  // acceptTop and expectAlso together.
  {
    label: 'one string, two headwords: the verb see and the noun saw',
    text: 'saw',
    expectKind: 'word',
    acceptTop: ['ראה', 'לראות'],
    expectAlso: ['מסור', 'לנסר'],
    // Phase 13. The inflection trap. A model that calls `booked` a misspelling of
    // `book` writes a redirect that never expires — partially self-limiting, since
    // the redirect is consulted only AFTER the by-form read misses, so once
    // `booked` is legitimately written the bad row is shadowed and inert. It bites
    // for a form never looked up correctly first. These three are the cases to
    // watch when a model version changes.
    expectNoCorrection: true,
  },
  // Phase 12 follow-up. `water` has two noun senses — the substance you drink and a body
  // of water you swim in — and Hebrew renders both מים, so the example is the
  // only thing that can tell the two cards apart. The recorded seed's second
  // example was "The water was cold.", which fits a glass and a lake equally
  // and so demonstrates neither. The prompt now requires an example that rules
  // the other senses out; this is the lock on the sentence that did not.
  {
    label: 'an example must rule out the word\'s other senses, not merely contain it',
    text: 'water',
    expectKind: 'word',
    acceptTop: ['מים'],
    expectAlso: ['להשקות'],
    rejectExample: ['The water was cold'],
  },
  // Phase 12 follow-up, F2. The model lemmatises verb forms to the base verb every time,
  // but wavers on participial adjectives: `burnt` came back as the adjective
  // `burn` while `burned` came back as the adjective `burned`. Two lexemes for
  // one adjective — British and American spellings of a single word — each with
  // its own sense list, neither ever able to see the other's, and reconciliation
  // structurally unable to help because it keys on the lemma that differs.
  //
  // The convention is the regular -ed spelling, so both of these must name
  // `burned`. `burning` is deliberately NOT expected to merge: an active
  // participle adjective is a different adjective from a passive one.
  {
    label: 'a participial adjective names one lemma whichever spelling is typed',
    text: 'burnt',
    expectKind: 'word',
    acceptTop: ['שרוף', 'שרף', 'נשרף'],
    expectLemmaFor: { adjective: 'burned' },
  },
  {
    label: 'and the other spelling names the same one',
    text: 'burned',
    expectKind: 'word',
    acceptTop: ['שרף', 'שרוף', 'נשרף'],
    expectLemmaFor: { adjective: 'burned' },
  },
  {
    label: 'gibberish returns nothing rather than an invented translation',
    text: 'asdkjhasd',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
    // Near NOTHING, as against near a word: the empty-entries answer and no
    // correction. Its `kind` must also be `word` — a correction dropped for empty
    // entries has changed nothing about the answer (criterion 7).
    expectNoCorrection: true,
  },
  // Phase 13. The reported defect itself, measured against the real model: the
  // model already reads `thruot` as `throat` and says so in `lemma`; what this
  // scores is that it now says so in `correction` instead of silently.
  {
    label: 'a misspelling one edit from a real word',
    text: 'thruot',
    expectKind: 'word',
    acceptTop: ['גרון'],
    expectCorrection: 'throat',
    // `thruot` is as close to `throughout` as to `throat`, and nothing asked the
    // model to enumerate corrections before this phase — it committed to one.
    expectAlternative: 'throughout',
  },
  {
    label: 'the classic transposition',
    text: 'recieve',
    expectKind: 'word',
    acceptTop: ['לקבל'],
    expectCorrection: 'receive',
  },
  // A phrase, not a word: scope is words and phrases, both directions.
  //
  // PROMPT CONTAMINATION: `buildPrompt`'s system instruction
  // (apps/server/src/domain/translation.ts:228) states verbatim '"break a leg"
  // is a phrase, not a sentence.' as its imperative-expression example, so the
  // corrected form this case expects is already in what the model reads. This
  // case measures prompt recall more than correction ability. Re-point it at
  // an example absent from the prompt the next time someone here has an API key.
  {
    label: 'a misspelled word inside a fixed expression',
    text: 'brake a leg',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה'],
    rejectAny: ['לשבור רגל'],
    expectCorrection: 'break a leg',
  },
  // The fourth prompt rule, and the ONLY case in the set where a SINGLE TOKEN
  // must be classified as a phrase. `brake a leg` above cannot score it: what was
  // typed already contains whitespace, so the model answers `phrase` with or
  // without the rule. This is the case where a model classifying the input as
  // typed answers `word`, the server's resolveKind DEFERS to it because the
  // corrected form has whitespace, and `kind: 'word'` is written onto the variant
  // `break a leg` permanently. It is also the case that forces the askModel
  // change: scored against the typed text it clamps to `word` and can never pass.
  //
  // PROMPT CONTAMINATION: `buildPrompt`'s system instruction
  // (apps/server/src/domain/translation.ts:340) states verbatim
  // '"breakaleg" is corrected to "break a leg", so its kind is "phrase" even
  // though what was typed is a single token.' — the exact correction this
  // case expects. This case measures prompt recall more than correction
  // ability. Re-point it at an example absent from the prompt the next time
  // someone here has an API key.
  {
    label: 'a single token corrected to a phrase',
    text: 'breakaleg',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה'],
    expectCorrection: 'break a leg',
  },
  // The Latin-script counterpart of ktiv male: a real word in one standard of
  // English that a model may "correct" to the American form, writing a permanent
  // redirect away from a correct spelling. Phase 12 met this shape with
  // `burnt`/`burned` and pinned a lemma rule for it; here the rule is the first
  // one — a correctly spelled form is not a misspelling — and this is the case
  // that scores its spelling-variant half.
  {
    label: 'a real spelling variant is not a misspelling',
    text: 'colour',
    expectKind: 'word',
    acceptTop: ['צבע'],
    expectNoCorrection: true,
  },
  // THERE IS DELIBERATELY NO HEBREW CORRECTION CASE, and the reason is worth
  // keeping so nobody adds one back on the same reasoning that failed.
  //
  // Phase 13 shipped one — `שולחם` expecting a correction to `שולחן` (table) —
  // and the first eval run against a real model failed it. The model read
  // `שולחם` as a legitimate inflected form of `שלח` and answered "it was sent to
  // them", which is defensible: the string IS a real Hebrew form. So the case
  // demanded the model "correct" a genuine word, which is precisely what the
  // `running`, `booked`, `saw` and `colour` cases above exist to prove it must
  // NOT do. The case contradicted the feature it was meant to measure, and it
  // also failed two tier 1 checks because the answer carried empty examples.
  //
  // This is the Hebrew-side risk the design flagged and could not resolve: ktiv
  // male against ktiv haser and optional nikud mean many valid Hebrew spellings
  // differ from one another, and `normalizeForm` deliberately strips neither —
  // so a Hebrew string that is unambiguously a misspelling and not merely an
  // alternative spelling is genuinely hard to choose. A replacement needs a
  // string no reading can make into a real word (a non-final letter in final
  // position is one candidate), and it needs an eval run to confirm the model
  // agrees before it is trusted. Correction behaviour is currently measured in
  // English only.

  // Phase 16 — Russian, explained in Hebrew. Each stresses one rule the language
  // table added; spec §6 lists them.
  {
    label: 'ru: a verb keeps the aspect typed',
    text: 'прочитала',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['קרא', 'קראה'],
    expectLemma: 'прочитать',
  },
  {
    label: 'ru: a noun case form belongs to its nominative singular',
    text: 'книги',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['ספרים', 'ספר', 'של הספר'],
    expectLemma: 'книга',
  },
  {
    label: 'ru: an idiom by meaning, not word for word',
    text: 'как дела?',
    from: 'ru',
    to: 'he',
    expectKind: 'phrase',
    acceptTop: ['מה שלומך', 'מה שלומך?', 'מה נשמע', 'מה נשמע?', 'מה העניינים', 'מה העניינים?'],
    rejectAny: ['איך מעשים', 'איך דברים'],
  },
  {
    label: 'ru: a missing ё is a misspelling, corrected to the word',
    text: 'елка',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['עץ אשוח', 'אשוח', 'עץ חג המולד'],
    expectCorrection: 'ёлка',
  },
  // The counterweight to `елка`, as `running`, `booked` and `colour` are to
  // phase 13's correction rule. Each is a real word in its е spelling with a ё
  // twin — все/всё, берет/берёт, небо/нёбо — so a ё rule that misfires here
  // writes a permanent redirect away from a correctly spelled word.
  {
    label: 'ru: an е spelling that is itself a word is not a missing ё (все)',
    text: 'все',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['כולם', 'הכל', 'הכול', 'כל'],
    expectNoCorrection: true,
  },
  // `берет` is itself a word — the noun "beret" — and is also how `берёт`
  // ("takes") is spelled with its ё written as е. Both readings are real, so
  // either top answer is acceptable; what is scored is that no correction is
  // offered.
  {
    label: 'ru: an е spelling that is itself a word is not a missing ё (берет)',
    text: 'берет',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['כומתה', 'לוקח', 'לוקחת'],
    expectNoCorrection: true,
  },
  {
    label: 'ru: an е spelling that is itself a word is not a missing ё (небо)',
    text: 'небо',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['שמיים', 'שמים'],
    expectNoCorrection: true,
  },
  {
    label: 'ru: a same-script word of another language is not Russian',
    text: 'дякую',
    from: 'ru',
    to: 'he',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
  },
  // The other side of `дякую`. The third-language rule first shipped without
  // its borrowing clause and turned these from translated to empty under en → he,
  // breaking learners who already used them: English uses them, but they are
  // French and German by origin. Hebrew slang is the same check in the other
  // direction — `סבבה` and `יאללה` are Arabic by origin and Hebrew by use.
  {
    label: 'a loan phrase in common use is the source language (déjà vu)',
    text: 'déjà vu',
    expectKind: 'phrase',
    acceptTop: ["דז'", 'דז׳'],
  },
  {
    label: 'a loanword in common use is the source language (schadenfreude)',
    text: 'schadenfreude',
    expectKind: 'word',
    acceptTop: ['שמחה לאיד'],
  },
  {
    label: 'a loan phrase in common use is the source language (bon appétit)',
    text: 'bon appétit',
    expectKind: 'phrase',
    acceptTop: ['בתאבון', 'בתיאבון'],
  },
  {
    label: 'he → en: Hebrew slang of Arabic origin is Hebrew (סבבה)',
    text: 'סבבה',
    from: 'he',
    to: 'en',
    expectKind: 'word',
    acceptTop: ['ok', 'OK', 'Ok', 'cool', 'Cool', 'fine', 'great', 'alright', 'all right', 'sure'],
  },
  {
    label: 'he → en: Hebrew slang of Arabic origin is Hebrew (יאללה)',
    text: 'יאללה',
    from: 'he',
    to: 'en',
    expectKind: 'word',
    acceptTop: ['come on', 'Come on', "let's go", "Let's go", 'go', 'hurry', 'yalla'],
  },
  {
    label: 'he → ru: a Hebrew word rendered in Russian',
    text: 'חלון',
    from: 'he',
    to: 'ru',
    expectKind: 'word',
    acceptTop: ['окно'],
  },

  // Phase 22 — Italian, explained in Hebrew. Each stresses one rule the Italian
  // entry added (spec §3). The prompt's own examples are different words, so
  // these measure the rules rather than recall of the examples.
  {
    label: 'it: a conjugated verb belongs to its infinitive',
    text: 'parlo',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    // The case is about the lemma. The model glosses a present-tense verb with the
    // infinitive as often as with the participle, and both mean the right thing.
    acceptTop: ['מדבר', 'אני מדבר', 'מדברת', 'אני מדברת', 'אני מדבר/ת', 'מדבר/ת', 'לדבר'],
    expectLemma: 'parlare',
  },
  {
    label: 'it: a plural noun belongs to its singular',
    text: 'libri',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['ספרים', 'ספר'],
    expectLemma: 'libro',
  },
  {
    label: 'it: a feminine adjective belongs to its masculine singular',
    text: 'bella',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['יפה', 'יפהפייה', 'יפהפיה'],
    expectLemma: 'bello',
  },
  {
    label: 'it: an idiom by meaning, not word for word',
    text: 'in bocca al lupo',
    from: 'it',
    to: 'he',
    expectKind: 'phrase',
    acceptTop: ['בהצלחה', 'בהצלחה!'],
    rejectAny: ['בפה של הזאב', 'בפי הזאב', 'בפה של זאב'],
  },
  {
    label: 'it: a missing accent is a misspelling, corrected to the word (perche)',
    text: 'perche',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['למה', 'מדוע', 'כי', 'מפני ש', 'מפני', 'בגלל ש', 'כיוון ש'],
    expectCorrection: 'perché',
  },
  {
    label: 'it: a missing accent is a misspelling, corrected to the word (citta)',
    text: 'citta',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['עיר'],
    expectCorrection: 'città',
  },
  // The counterweights, as все, берет and небо are to the ё rule: each is a real
  // word without its accent, so a misfiring rule writes a permanent redirect
  // away from a correctly spelled word.
  {
    label: 'it: an unaccented spelling that is itself a word is not a missing accent (se)',
    text: 'se',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['אם'],
    expectNoCorrection: true,
  },
  {
    label: 'it: an unaccented spelling that is itself a word is not a missing accent (papa)',
    text: 'papa',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['אפיפיור', 'האפיפיור', 'אבא'],
    expectNoCorrection: true,
  },
  {
    label: 'it: an English word is not Italian, though the guard passes it',
    text: 'window',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
  },
  // The counterweight to `window`, as `déjà vu` is to the third-language rule:
  // Italian really uses this English word, so it is Italian and translates.
  {
    label: 'it: an English loanword Italian uses is Italian (computer)',
    text: 'computer',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['מחשב'],
    expectNoCorrection: true,
  },
  // And the false friends: Italian words spelled like English ones, which a
  // beginner types first. A misfiring English rule would answer them empty.
  {
    label: 'it: an Italian word spelled like an English one is Italian (come)',
    text: 'come',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['איך', 'כמו', 'כיצד'],
    expectNoCorrection: true,
  },
  {
    label: 'it: an Italian word spelled like an English one is Italian (camera)',
    text: 'camera',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['חדר', 'חדר שינה'],
    expectNoCorrection: true,
  },
  {
    label: 'he → it: a Hebrew word rendered in Italian',
    text: 'חלון',
    from: 'he',
    to: 'it',
    expectKind: 'word',
    acceptTop: ['finestra'],
  },
  {
    // Not הלך: that is also the Hebrew dictionary headword of the verb, so the
    // infinitive `andare` is a fair answer to it. הלכנו is past and nothing else.
    // It always loses the tier 2 stem check: the lemma ללכת is no substring of
    // an example built around הלכנו, a limit of that heuristic for Hebrew.
    label: 'he → it: a Hebrew past tense takes the passato prossimo',
    text: 'הלכנו',
    from: 'he',
    to: 'it',
    expectKind: 'word',
    acceptTop: ['siamo andati', 'siamo andate', 'è andato', 'abbiamo camminato'],
    rejectTop: ['andammo', 'andavamo', 'andare', 'camminammo', 'camminare'],
  },
];

/**
 * A case for the **second** call — `buildRenderingPrompt`, which renders a
 * lexeme the dictionary already holds for a newly queried form.
 *
 * Separate from `EvalCase` rather than a variant of it because almost nothing
 * transfers: there is no `kind` to classify, no entry split to score, and no
 * ranking across lexemes. What there is instead is a lexeme fixed in advance
 * and a list of senses already stored against it.
 */
export type RenderingCase = {
  label: string;
  /** The form a learner typed — what the stored senses must be rendered for. */
  form: string;
  /** Defaults to en → he. */
  from?: LanguageCode;
  to?: LanguageCode;
  /** The lexeme being rendered: a lemma AND a part of speech, since phase 12. */
  lemma: string;
  partOfSpeech: PartOfSpeech;
  /** What the dictionary already holds for that lexeme, as
   *  `repo/dictionary.ts`'s findSensesByLexeme would have returned it. */
  stored: StoredSense[];
  /** Stored codes that must come back reused, carrying a translation. Reuse is
   *  the entire reason this call exists — a renamed code stores the meaning
   *  twice, forever. */
  expectReused?: string[];
  /** Must appear as no translation at all. This is how a reading belonging to a
   *  DIFFERENT lexeme of the same form is rejected: `pressing` is the verb
   *  `press` and the adjective `pressing`, and the verb's rendering must not
   *  claim the adjective's meaning. */
  rejectAny?: string[];
};

export const RENDERING_CASES: RenderingCase[] = [
  // The phase 12 follow-up defect, reduced to its two inputs. `press`/verb holds these
  // five senses; the form `pressing` also belongs to a SEPARATE lexeme,
  // `pressing`/adjective, which call 1 returns as its own entry. Asked what
  // readings of "pressing" the list below lacks, the model answered דחוף
  // (urgent) — truthfully, and onto the wrong lexeme. The stored senses are
  // copied out of the dev database as they stood immediately before the lookup
  // that produced the duplicate.
  {
    label: 'a form spanning two lexemes: the verb must not claim the adjective reading',
    form: 'pressing',
    lemma: 'press',
    partOfSpeech: 'verb',
    stored: [
      {
        senseCode: 'applied_force',
        translation: 'ללחוץ',
        exampleSource: 'Press the button firmly.',
        exampleTarget: 'ללחוץ על הכפתור בחוזקה.',
      },
      {
        senseCode: 'urged_insisted',
        translation: 'לדחוק',
        exampleSource: 'They will press him for details.',
        exampleTarget: 'הם ידחקו בו לפרטים.',
      },
      {
        senseCode: 'extracted_liquid',
        translation: 'סחט',
        exampleSource: 'He pressed the grapes for wine.',
        exampleTarget: 'הוא סחט את הענבים ליין.',
      },
      {
        senseCode: 'ironed_clothes',
        translation: 'לגהץ',
        exampleSource: 'She needs to press her uniform.',
        exampleTarget: 'היא צריכה לגהץ את המדים שלה.',
      },
      {
        senseCode: 'publish_print',
        translation: 'להדפיס',
        exampleSource: 'The publisher decided to press more copies of the book.',
        exampleTarget: 'המוציא לאור החליט להדפיס עותקים נוספים של הספר.',
      },
    ],
    expectReused: ['applied_force', 'urged_insisted', 'extracted_liquid', 'ironed_clothes'],
    // דחוף is the adjective lexeme's reading. The verb rendering must not carry
    // it under any code, new or reused.
    rejectAny: ['דחוף'],
  },
  // The counterweight, and it must stay green. Forbidding new sense codes
  // outright would fix the case above and break this call's actual purpose:
  // `bank` names a sense river_bank where `banks` would have named it
  // river_edge, and reuse is what stops the dictionary holding both. A fix that
  // makes the model afraid to answer shows up here, not above.
  {
    label: 'a sense the model would name differently is reused, not stored twice',
    form: 'banks',
    lemma: 'bank',
    partOfSpeech: 'noun',
    stored: [
      {
        senseCode: 'financial_institution',
        translation: 'בנק',
        exampleSource: 'The bank approved the loan.',
        exampleTarget: 'הבנק אישר את ההלוואה.',
      },
      {
        senseCode: 'river_bank',
        translation: 'גדה',
        exampleSource: 'We sat on the bank of the river.',
        exampleTarget: 'ישבנו על גדת הנהר.',
      },
    ],
    expectReused: ['financial_institution', 'river_bank'],
  },
];

/**
 * Phase 19. One distractor call per case, as a list session makes it. Tier 1 is
 * the contract: every item answered with three distinct wrong options, none the
 * answer, all in the answer's script. Tier 2 is the failure that matters most
 * to a learner, a "wrong" option that is right: `synonyms` lists known right
 * answers that must never appear.
 *
 * Phase 23. Each item has a task (default `meaning`, today's card). For `word`
 * (the reversed card) the options and `synonyms` are in the learned language.
 * For `typed` there are no wrong options; tier 1 asks that the alternatives are
 * in the learned language, and tier 2 that at least one of `alternatives`, the
 * well-known other right answers, is listed.
 */
export type DistractorCase = {
  label: string;
  from: LanguageCode;
  to: LanguageCode;
  items: {
    task?: Task;
    form: string;
    lemma: string;
    partOfSpeech: PartOfSpeech;
    translation: string;
    synonyms: string[];
    alternatives?: string[];
  }[];
};

export const DISTRACTOR_CASES: DistractorCase[] = [
  {
    label: 'Italian words of four parts of speech',
    from: 'it',
    to: 'he',
    items: [
      { form: 'parlo', lemma: 'parlare', partOfSpeech: 'verb', translation: 'מדבר', synonyms: ['משוחח', 'אומר'] },
      { form: 'casa', lemma: 'casa', partOfSpeech: 'noun', translation: 'בית', synonyms: ['דירה', 'מעון'] },
      { form: 'sempre', lemma: 'sempre', partOfSpeech: 'adverb', translation: 'תמיד', synonyms: ['כל הזמן', 'לעולם'] },
      { form: 'bella', lemma: 'bello', partOfSpeech: 'adjective', translation: 'יפה', synonyms: ['נאה', 'יפהפייה'] },
    ],
  },
  {
    label: 'Russian words of four parts of speech',
    from: 'ru',
    to: 'he',
    items: [
      { form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה', synonyms: ['סיימה לקרוא', 'קראה עד הסוף'] },
      { form: 'окно', lemma: 'окно', partOfSpeech: 'noun', translation: 'חלון', synonyms: ['אשנב', 'צוהר'] },
      { form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר', synonyms: ['במהירות', 'חיש'] },
      { form: 'красивая', lemma: 'красивый', partOfSpeech: 'adjective', translation: 'יפה', synonyms: ['נאה', 'יפהפייה'] },
    ],
  },
  {
    label: 'English everyday words, where synonyms are easy to offer',
    from: 'en',
    to: 'he',
    items: [
      { form: 'difficult', lemma: 'difficult', partOfSpeech: 'adjective', translation: 'קשה', synonyms: ['מסובך', 'מורכב'] },
      { form: 'friend', lemma: 'friend', partOfSpeech: 'noun', translation: 'חבר', synonyms: ['ידיד', 'רע'] },
      { form: 'to remember', lemma: 'remember', partOfSpeech: 'verb', translation: 'לזכור', synonyms: ['להיזכר', 'לא לשכוח'] },
      { form: 'thank you', lemma: 'thank you', partOfSpeech: 'interjection', translation: 'תודה', synonyms: ['תודה רבה', 'תודה לך'] },
    ],
  },
  {
    label: 'Polysemous word saved as two senses in one batch',
    from: 'ru',
    to: 'he',
    items: [
      { form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', synonyms: ['קשת'] },
      { form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'קשת', synonyms: ['בצל'] },
      { form: 'ключ', lemma: 'ключ', partOfSpeech: 'noun', translation: 'מפתח', synonyms: ['מעיין'] },
      { form: 'ключ', lemma: 'ключ', partOfSpeech: 'noun', translation: 'מעיין', synonyms: ['מפתח'] },
      { form: 'окно', lemma: 'окно', partOfSpeech: 'noun', translation: 'חלון', synonyms: ['אשנב', 'צוהר'] },
    ],
  },
  {
    label: 'Italian words to pick, the Hebrew shown',
    from: 'it',
    to: 'he',
    items: [
      { task: 'word', form: 'parlo', lemma: 'parlare', partOfSpeech: 'verb', translation: 'מדבר', synonyms: ['parla', 'parli', 'discorro'] },
      { task: 'word', form: 'casa', lemma: 'casa', partOfSpeech: 'noun', translation: 'בית', synonyms: ['abitazione', 'dimora'] },
      { task: 'word', form: 'sempre', lemma: 'sempre', partOfSpeech: 'adverb', translation: 'תמיד', synonyms: ['ognora'] },
      { task: 'word', form: 'bella', lemma: 'bello', partOfSpeech: 'adjective', translation: 'יפה', synonyms: ['bello', 'carina', 'graziosa'] },
    ],
  },
  {
    label: 'Russian words to pick, the Hebrew shown',
    from: 'ru',
    to: 'he',
    items: [
      { task: 'word', form: 'окно', lemma: 'окно', partOfSpeech: 'noun', translation: 'חלון', synonyms: ['оконце'] },
      { task: 'word', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר', synonyms: ['живо', 'стремительно', 'шустро'] },
      { task: 'word', form: 'красивая', lemma: 'красивый', partOfSpeech: 'adjective', translation: 'יפה', synonyms: ['прекрасная', 'красивый', 'симпатичная'] },
    ],
  },
  {
    // Review: two saved words with one meaning. On each reversed card the other
    // word is right too, so offering it fails tier 1 (validateDistractors).
    label: 'Two saved Italian words with one meaning, both to pick',
    from: 'it',
    to: 'he',
    items: [
      { task: 'word', form: 'bella', lemma: 'bello', partOfSpeech: 'adjective', translation: 'יפה', synonyms: ['carina', 'bello'] },
      { task: 'word', form: 'carina', lemma: 'carino', partOfSpeech: 'adjective', translation: 'יפה', synonyms: ['bella', 'carino'] },
      { task: 'word', form: 'casa', lemma: 'casa', partOfSpeech: 'noun', translation: 'בית', synonyms: ['abitazione'] },
    ],
  },
  {
    label: 'Typed answers with well-known synonyms',
    from: 'en',
    to: 'he',
    items: [
      { task: 'typed', form: 'big', lemma: 'big', partOfSpeech: 'adjective', translation: 'גדול', synonyms: [], alternatives: ['large'] },
      { task: 'typed', form: 'begin', lemma: 'begin', partOfSpeech: 'verb', translation: 'להתחיל', synonyms: [], alternatives: ['start', 'commence'] },
      { task: 'typed', form: 'quickly', lemma: 'quickly', partOfSpeech: 'adverb', translation: 'מהר', synonyms: [], alternatives: ['fast', 'rapidly'] },
    ],
  },
  {
    label: 'A mixed session, as prepare-session sends it',
    from: 'it',
    to: 'he',
    items: [
      { task: 'meaning', form: 'libro', lemma: 'libro', partOfSpeech: 'noun', translation: 'ספר', synonyms: ['כרך'] },
      { task: 'word', form: 'finestra', lemma: 'finestra', partOfSpeech: 'noun', translation: 'חלון', synonyms: ['finestrella'] },
      { task: 'typed', form: 'macchina', lemma: 'macchina', partOfSpeech: 'noun', translation: 'מכונית', synonyms: [], alternatives: ['auto', 'automobile'] },
      { task: 'meaning', form: 'acqua', lemma: 'acqua', partOfSpeech: 'noun', translation: 'מים', synonyms: [] },
    ],
  },
];

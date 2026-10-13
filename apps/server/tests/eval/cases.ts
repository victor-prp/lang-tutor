import type { ClozeTypedQuestion, LanguageCode, PartOfSpeech, SentenceTranslationQuestion, TranslationKind } from '@lang-tutor/core/api';
import type { QuestionType, TypedTarget } from '@lang-tutor/core/domain';

import type { CheckItem } from '../../src/domain/check';
import type { Task } from '../../src/domain/distractors';
import type { JudgeContext, MeaningJudgeContext } from '../../src/domain/judge';
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
  /** Phase 31 (spec D4). Every sense's translation is one translation: no comma,
   *  slash or semicolon list and no parenthetical. */
  expectOneTranslation?: true;
  /** Phase 31 (spec D6). The first entry's first sense names one of these as its
   *  citation form, compared by normaliseGloss. */
  expectGloss?: string[];
  /** Phase 31 (spec D5). Every alternative and citation alternative is in this script. */
  expectAlternativesIn?: LanguageCode;
  /** Phase 31 (spec D5). Some sense lists one of these among its alternatives. */
  expectAlternativeWord?: string[];
  /** Phase 31 (spec D9). Every sense has a definition, in this script. */
  expectDefinitionIn?: LanguageCode;
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
  // Three parts of speech of one lemma, which is why the entry cap once went 3 -> 6.
  // Phase 31 took it back to 3 (see LlmTranslationSchema.entries), so this case now
  // fills the cap exactly.
  {
    label: 'three parts of speech of one lemma, filling the entry cap',
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
  // Phase 26 follow-up. A slash list typed whole is a correction to its first
  // word, the rest offered as alternatives. Without one, the dictionary writes
  // `decorate / decoration` as a form of both lexemes, and a saved sense shows
  // it in every session. The prompt illustrates with `decide / decision` and
  // `sing / sang`, so none of these four is in what the model reads.
  {
    label: 'a slash list of two words corrects to the first',
    text: 'decorate / decoration',
    expectKind: 'word',
    acceptTop: ['לקשט', 'לעטר', 'לייפות'],
    expectCorrection: 'decorate',
    expectAlternative: 'decoration',
  },
  {
    label: 'a slash between two forms of one word corrects to the first',
    text: 'go / going',
    expectKind: 'word',
    acceptTop: ['ללכת', 'לנסוע'],
    expectCorrection: 'go',
    expectAlternative: 'going',
  },
  {
    label: 'it: a gender ending after a slash corrects to the word as written first',
    text: 'amico/a',
    from: 'it',
    to: 'he',
    expectKind: 'word',
    acceptTop: ['חבר', 'ידיד'],
    expectCorrection: 'amico',
    expectAlternative: 'amica',
  },
  // The trap: a slash inside one expression. `24/7` illustrates it in the
  // prompt; this is the case that shows the model generalises past it.
  {
    label: 'a slash inside one expression is not a list',
    text: 'and/or',
    expectKind: 'word',
    acceptTop: ['ו/או'],
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
  // A third way to misfire the rule: not a loanword, but a plain English word
  // that French spells the same. `pour` answered empty in every call, which a
  // textbook import showed as "no meaning"; it was the only one of 58 such
  // words scanned in English, Italian and Russian that did.
  {
    label: 'an English word that French spells the same is English (pour)',
    text: 'pour',
    expectKind: 'word',
    acceptTop: ['למזוג', 'לשפוך', 'מזג', 'שפך'],
    expectNoCorrection: true,
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
  // Phase 31 (spec D4, D5, D9). One main translation, the other target words as
  // alternatives in the same language, and a definition in the headword's.
  {
    label: 'one main translation, the other target words as alternatives (phase 31)',
    text: 'car',
    expectKind: 'word',
    acceptTop: ['מכונית', 'רכב', 'אוטו'],
    expectOneTranslation: true,
    expectAlternativesIn: 'he',
    expectAlternativeWord: ['רכב', 'אוטו', 'מכונית'],
    expectDefinitionIn: 'en',
  },
  // Phase 31 (spec D4). One meaning that Hebrew says in two words stays whole.
  {
    label: 'a compound translation survives whole (phase 31)',
    text: 'café',
    expectKind: 'word',
    acceptTop: ['בית קפה'],
    expectOneTranslation: true,
  },
  // Phase 31 (spec D6). The translation inflects with the form; the citation form does not.
  {
    label: 'an inflected form keeps its citation form uninflected (phase 31)',
    text: 'fingers',
    expectKind: 'word',
    acceptTop: ['אצבעות'],
    expectLemma: 'finger',
    expectGloss: ['אצבע'],
    expectOneTranslation: true,
  },
  {
    label: 'a Russian plural: a singular citation form and a Russian definition (phase 31)',
    text: 'столы',
    from: 'ru',
    expectKind: 'word',
    acceptTop: ['שולחנות'],
    expectGloss: ['שולחן'],
    expectDefinitionIn: 'ru',
  },
  // Phase 31 (Review Focus 5). Lane 0 stored "קומבינציה, צירוף" for this word.
  {
    label: 'no comma list where lane 0 held one (phase 31)',
    text: 'combination',
    expectKind: 'word',
    acceptTop: ['שילוב', 'צירוף', 'קומבינציה'],
    expectOneTranslation: true,
    expectAlternativesIn: 'he',
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
  // Phase 31 (spec D9). The first learner of a new language: the stored sense
  // has no gloss in Russian, only its Hebrew definition and its English gloss,
  // and its code must still come back reused.
  {
    label: 'a sense with no gloss in this language is reused by its definition (phase 31)',
    form: 'חלונות',
    from: 'he',
    to: 'ru',
    lemma: 'חלון',
    partOfSpeech: 'noun',
    stored: [
      {
        senseCode: 'wall_opening',
        definition: 'פתח בקיר שמכניס אור ואוויר',
        translation: 'window',
        glossLanguage: 'en',
        exampleSource: 'פתחתי את החלון כדי להכניס אוויר.',
        exampleTarget: 'I opened the window to let air in.',
      },
    ],
    expectReused: ['wall_opening'],
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
  /** Phase 48 (spec D8). Also asks the real checker, and at least three wrong options must survive it. */
  checked?: boolean;
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
    // Phase 47 (spec D7). The word items of lane 0's failed stock c0c71c16
    // (2026-10-13), with its two typed items. Uncapped, gemini-2.5-flash once
    // thought 62,910 tokens over this batch and offered Hebrew wrong options
    // for both words to pick. At 4096 it answered in English (spec D1).
    label: 'English words to pick where the model once answered in Hebrew (century, dish)',
    from: 'en',
    to: 'he',
    items: [
      { task: 'word', form: 'century', lemma: 'century', partOfSpeech: 'noun', translation: 'מאה', synonyms: [] },
      { task: 'typed', form: 'drum', lemma: 'drum', partOfSpeech: 'noun', translation: 'תוף', synonyms: [], alternatives: [] },
      { task: 'word', form: 'dish', lemma: 'dish', partOfSpeech: 'noun', translation: 'צלחת', synonyms: ['plate'] },
      { task: 'typed', form: 'train', lemma: 'train', partOfSpeech: 'verb', translation: 'לאמן', synonyms: [], alternatives: [] },
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
  {
    // Phase 48 (spec D8). The bots' 9cb1b1a8: vero's reversed card got Hebrew options, and broad
    // words leave few wrong meanings the checker accepts.
    label: 'vero, a broad Italian word, both ways',
    from: 'it',
    to: 'he',
    checked: true,
    items: [
      { task: 'meaning', form: 'vero', lemma: 'vero', partOfSpeech: 'adjective', translation: 'אמיתי', synonyms: ['נכון', 'אמת', 'ממשי', 'מציאותי', 'אותנטי', 'כן', 'באמת', 'צודק', 'מדויק'] },
      { task: 'word', form: 'vero', lemma: 'vero', partOfSpeech: 'adjective', translation: 'אמיתי', synonyms: ['giusto', 'esatto', 'corretto', 'certo', 'reale', 'autentico', 'verace', 'davvero', 'vera', 'sì'] },
    ],
  },
];

/**
 * Phase 25 (spec §2, Eval). One clip each, said right or said as another word.
 * Made with macOS `say` and 0.6 s of silence on each side, as a recording has:
 *
 *   say -v Alice -o "$TMPDIR/clip.wav" --file-format=WAVE --data-format=LEI16@16000 "[[slnc 600]] gatto [[slnc 600]]"
 *   afconvert -f adts -d aac "$TMPDIR/clip.wav" apps/server/tests/eval/audio/it-gatto.aac
 *
 * Synthetic voices, not a learner's accent: these prove the path and the
 * instruction, not accuracy for Victor's voice (spec, Risks).
 */
export type TranscriptionCase = {
  label: string;
  file: string;
  language: 'it' | 'ru' | 'en';
  target: string;
  expect: 'understood' | 'unheard';
};

const said = (language: TranscriptionCase['language'], file: string, target: string): TranscriptionCase => ({
  label: `${language}: ${target} said right`,
  file,
  language,
  target,
  expect: 'understood',
});
const other = (language: TranscriptionCase['language'], file: string, target: string, spoken: string): TranscriptionCase => ({
  label: `${language}: ${spoken} said for ${target}`,
  file,
  language,
  target,
  expect: 'unheard',
});

export const TRANSCRIPTION_CASES: TranscriptionCase[] = [
  said('it', 'it-gatto', 'gatto'),
  said('it', 'it-perche', 'perché'),
  said('it', 'it-finestra', 'finestra'),
  said('it', 'it-cucchiaio', 'cucchiaio'),
  said('it', 'it-citta', 'città'),
  said('it', 'it-per-favore', 'per favore'),
  said('it', 'it-caffe-con-cornetto', 'caffè con cornetto'),
  said('it', 'it-grazie-mille', 'grazie mille'),
  other('it', 'it-gato', 'gatto', 'gato'),
  other('it', 'it-cane', 'gatto', 'cane'),
  said('ru', 'ru-moloko', 'молоко'),
  said('ru', 'ru-yolka', 'ёлка'),
  said('ru', 'ru-luk', 'лук'),
  said('ru', 'ru-spasibo', 'спасибо'),
  said('ru', 'ru-lozhka', 'ложка'),
  said('ru', 'ru-dobroe-utro', 'доброе утро'),
  other('ru', 'ru-lyuk', 'лук', 'люк'),
  other('ru', 'ru-les', 'лук', 'лес'),
  said('en', 'en-through', 'through'),
  said('en', 'en-weather', 'weather'),
  said('en', 'en-knife', 'knife'),
  said('en', 'en-island', 'island'),
  said('en', 'en-thank-you', 'thank you'),
  said('en', 'en-good-morning', 'good morning'),
  other('en', 'en-taught', 'thought', 'taught'),
  other('en', 'en-bat', 'bad', 'bat'),
];


/**
 * Phase 27. The meaning judge: a saved word with its example, a Hebrew answer
 * that is not the stored meaning (the rules decide that one without a call), and
 * the verdict a careful Hebrew-speaking teacher would give.
 */
export type JudgeCase = {
  label: string;
  context: MeaningJudgeContext;
  answer: string;
  expect: 'exact' | 'alternative' | 'wrong';
};

const judge = (
  language: 'it' | 'ru' | 'en',
  word: { form: string; lemma?: string; pos: PartOfSpeech; meaning: string; example: string; translation: string },
  answer: string,
  expect: JudgeCase['expect'],
  what: string,
): JudgeCase => ({
  label: `judge ${language} ${what}: ${word.lemma ?? word.form} \u2192 ${answer}`,
  context: {
    language,
    explanation: 'he',
    form: word.form,
    lemma: word.lemma ?? word.form,
    partOfSpeech: word.pos,
    meaning: word.meaning,
    example: word.example,
    exampleTranslation: word.translation,
  },
  answer,
  expect,
});

const itPrenotare = {
  form: 'prenotare', pos: 'verb' as const, meaning: 'להזמין',
  example: 'Voglio prenotare un tavolo per due.', translation: 'אני רוצה להזמין שולחן לשניים.',
};
const itComprare = {
  form: 'compro', lemma: 'comprare', pos: 'verb' as const, meaning: 'לקנות',
  example: 'Compro il pane ogni mattina.', translation: 'אני קונה לחם כל בוקר.',
};
const itParla = {
  form: 'parla', lemma: 'parlare', pos: 'verb' as const, meaning: 'לדבר',
  example: 'Lei parla tre lingue.', translation: 'היא מדברת בשלוש שפות.',
};
const itPianta = {
  form: 'pianta', pos: 'noun' as const, meaning: 'צמח',
  example: 'Questa pianta ha bisogno di luce.', translation: 'הצמח הזה צריך אור.',
};
const itCampo = {
  form: 'campo', pos: 'noun' as const, meaning: 'שדה',
  example: 'Il contadino lavora nel campo.', translation: 'האיכר עובד בשדה.',
};

const ruSpeshit = {
  form: 'спешу', lemma: 'спешить', pos: 'verb' as const, meaning: 'למהר',
  example: 'Я спешу на работу.', translation: 'אני ממהר לעבודה.',
};
const ruKrasivyj = {
  form: 'красивый', pos: 'adjective' as const, meaning: 'יפה',
  example: 'Это очень красивый город.', translation: 'זו עיר יפה מאוד.',
};
const ruGovorit = {
  form: 'говорит', lemma: 'говорить', pos: 'verb' as const, meaning: 'לדבר',
  example: 'Он говорит очень быстро.', translation: 'הוא מדבר מהר מאוד.',
};
const ruKniga = {
  form: 'книга', pos: 'noun' as const, meaning: 'ספר',
  example: 'Эта книга очень интересная.', translation: 'הספר הזה מעניין מאוד.',
};
const ruLuk = {
  form: 'лук', pos: 'noun' as const, meaning: 'בצל',
  example: 'Я режу лук для супа.', translation: 'אני חותך בצל למרק.',
};
const ruKlyuch = {
  form: 'ключ', pos: 'noun' as const, meaning: 'מפתח',
  example: 'Я потерял ключ от дома.', translation: 'איבדתי את המפתח של הבית.',
};

const enBegin = {
  form: 'begin', pos: 'verb' as const, meaning: 'להתחיל',
  example: 'We begin at nine.', translation: 'אנחנו מתחילים בתשע.',
};
const enBuy = {
  form: 'buy', pos: 'verb' as const, meaning: 'לקנות',
  example: 'I want to buy some bread.', translation: 'אני רוצה לקנות קצת לחם.',
};
const enRun = {
  form: 'run', pos: 'verb' as const, meaning: 'לרוץ',
  example: 'I run every morning.', translation: 'אני רץ כל בוקר.',
};
const enBook = {
  form: 'book', pos: 'verb' as const, meaning: 'להזמין',
  example: 'I want to book a table.', translation: 'אני רוצה להזמין שולחן.',
};
const enBank = {
  form: 'bank', pos: 'noun' as const, meaning: 'בנק',
  example: 'I went to the bank to take out money.', translation: 'הלכתי לבנק למשוך כסף.',
};

// Phase 42 (spec D2). One sense saved; a nearby idea is not another sense.
const enImagination = {
  form: 'imagination', pos: 'noun' as const, meaning: 'דמיון',
  example: 'Her imagination helps her write stories.', translation: 'הדמיון שלה עוזר לה לכתוב סיפורים.',
};

// Phase 34 (spec D7). A generated pair, as findJudgeContext now gives it.
const enSawCard = {
  form: 'saw', pos: 'verb' as const, meaning: 'לנסר',
  example: 'Can you saw this wood for me?', translation: 'האם תוכל לנסר את העץ הזה בשבילי?',
};

export const JUDGE_CASES: JudgeCase[] = [
  judge('it', itPrenotare, 'לשריין', 'exact', 'synonym'),
  judge('it', itComprare, 'לרכוש', 'exact', 'synonym'),
  judge('it', itParla, 'מדבר', 'exact', 'other form'),
  judge('it', itParla, 'דיבר', 'exact', 'other tense'),
  judge('it', { form: 'libro', pos: 'noun', meaning: 'ספר', example: 'Leggo un libro ogni settimana.', translation: 'אני קורא ספר כל שבוע.' }, 'הספר', 'exact', 'prefix'),
  judge('it', itPianta, 'מפה', 'alternative', 'other sense'),
  judge('it', itCampo, 'מחנה', 'alternative', 'other sense'),
  judge('it', itPrenotare, 'לבטל', 'wrong', 'related but different'),
  judge('it', { form: 'cane', pos: 'noun', meaning: 'כלב', example: 'Il cane dorme sul divano.', translation: 'הכלב ישן על הספה.' }, 'חיה', 'wrong', 'too general'),
  judge('it', { form: 'finestra', pos: 'noun', meaning: 'חלון', example: 'Apri la finestra, per favore.', translation: 'פתח את החלון, בבקשה.' }, 'שולחן', 'wrong', 'unrelated'),

  judge('ru', ruSpeshit, 'להזדרז', 'exact', 'synonym'),
  judge('ru', ruKrasivyj, 'נאה', 'exact', 'synonym'),
  judge('ru', ruGovorit, 'מדבר', 'exact', 'other form'),
  judge('ru', ruGovorit, 'דיבר', 'exact', 'other tense'),
  judge('ru', ruKniga, 'הספר', 'exact', 'prefix'),
  judge('ru', ruLuk, 'קשת', 'alternative', 'other sense'),
  judge('ru', ruKlyuch, 'מעיין', 'alternative', 'other sense'),
  judge('ru', { form: 'купить', pos: 'verb', meaning: 'לקנות', example: 'Я хочу купить хлеб.', translation: 'אני רוצה לקנות לחם.' }, 'למכור', 'wrong', 'related but different'),
  judge('ru', ruSpeshit, 'ללכת', 'wrong', 'too general'),
  judge('ru', { form: 'хлеб', pos: 'noun', meaning: 'לחם', example: 'Хлеб лежит на столе.', translation: 'הלחם מונח על השולחן.' }, 'ים', 'wrong', 'unrelated'),

  // Was 'לפתוח', which the model called another sense on every run, and a teacher could too
  // ("open" is not "begin" in this example) — replaced with להחל, an unarguable synonym.
  judge('en', enBegin, 'להחל', 'exact', 'synonym'),
  judge('en', enBuy, 'לרכוש', 'exact', 'synonym'),
  judge('en', enRun, 'רץ', 'exact', 'other form'),
  judge('en', enRun, 'רצתי', 'exact', 'other tense'),
  judge('en', enBook, 'להזמן', 'exact', 'small typo'),
  judge('en', enBook, 'ספר', 'alternative', 'other sense'),
  judge('en', enBank, 'גדה', 'alternative', 'other sense'),
  judge('en', enImagination, 'הזייה', 'wrong', 'a nearby idea, not a sense'),
  judge('en', enImagination, 'יצירתיות', 'wrong', 'related but different'),
  // Review M1, M2. Held out of the prompt's own examples: a near idea of another
  // word is still wrong, and a close synonym is still right.
  judge('en', { form: 'memory', pos: 'noun', meaning: 'זיכרון', example: 'I have a clear memory of that day.', translation: 'יש לי זיכרון ברור מהיום ההוא.' }, 'נוסטלגיה', 'wrong', 'a nearby idea, not a sense'),
  judge('en', { form: 'happy', pos: 'adjective', meaning: 'שמח', example: 'She is happy with her new job.', translation: 'היא שמחה בעבודה החדשה שלה.' }, 'מרוצה', 'exact', 'close synonym'),
  judge('en', enBook, 'לבטל', 'wrong', 'related but different'),
  judge('en', { form: 'tulip', pos: 'noun', meaning: 'צבעוני', example: 'She planted a red tulip.', translation: 'היא שתלה צבעוני אדום.' }, 'פרח', 'wrong', 'too general'),
  judge('en', { form: 'window', pos: 'noun', meaning: 'חלון', example: 'Please close the window.', translation: 'בבקשה סגור את החלון.' }, 'כלב', 'wrong', 'unrelated'),

  // Part A's deferred finding: the harder answers a learner really types.
  // Niqqud on a form the rules do not already know (the stored meaning with points
  // is the rule's, so these are other forms).
  judge('it', itPrenotare, 'לְשַׁרְיֵן', 'exact', 'niqqud'),
  judge('ru', ruGovorit, 'מְדַבֵּר', 'exact', 'niqqud'),
  judge('en', enRun, 'רָץ', 'exact', 'niqqud'),
  // ש and ו prefixes in front of the right meaning.
  judge('it', { form: 'libro', pos: 'noun', meaning: 'ספר', example: 'Leggo un libro ogni settimana.', translation: 'אני קורא ספר כל שבוע.' }, 'וספר', 'exact', 'ו prefix'),
  judge('ru', ruGovorit, 'שמדבר', 'exact', 'ש prefix'),
  judge('en', enBuy, 'ולקנות', 'exact', 'ו and ל prefixes'),
  // A near-synonym in another register is still the meaning.
  judge('ru', ruSpeshit, 'להיחפז', 'exact', 'formal register'),
  judge('ru', ruKrasivyj, 'יפהפה', 'exact', 'stronger register'),
  // An answer in English is not an answer in Hebrew (spec D3).
  judge('it', itParla, 'to speak', 'wrong', 'English answer'),
  judge('ru', ruKniga, 'book', 'wrong', 'English answer'),
  judge('en', enBuy, 'to buy', 'wrong', 'English answer'),
  // The word typed back, untranslated.
  judge('it', itParla, 'parla', 'wrong', 'the word typed back'),
  judge('ru', ruKniga, 'книга', 'wrong', 'the word typed back'),
  judge('en', enBook, 'book', 'wrong', 'the word typed back'),

  // Phase 34 (spec D7). The judge is given the sentence the card showed and its
  // hidden Hebrew, not the saved example: this pair is the one the context call
  // wrote for 71b0b407's `saw` on 2026-10-11 (CONTEXT_CASES' first case).
  judge('en', enSawCard, 'מנסר', 'exact', 'other form, on the card’s generated sentence'),
  judge('en', enSawCard, 'לשבור', 'wrong', 'unrelated, on the card’s generated sentence'),
];

/**
 * Phase 27 Part B. The three tasks that write a sentence or wrong words for one,
 * run as prepareSession runs them (several items to one call) and scored on what
 * the card would need:
 *
 *  - gap: the wrong options of a saved example's blank. Tier 1 is validateDistractors
 *    (three distinct non-empty options in the learned language, none the answer);
 *    tier 2 is that none of `fits`, the words that would also fill the blank, is offered.
 *  - sentence / translate: a new sentence. Tier 1 is that the item passes validation
 *    (not degraded: a degrading prompt means a learner sees a typed translation
 *    instead of the card); tier 2 is that no `offSense` word, one that only the
 *    wrong sense of a polysemous word would bring, appears as a whole word in the
 *    sentence or its translation. Phase 38 (spec D2): a sentence item also lists at
 *    least one other word that fits its gap with the sentence read alone.
 */
export type SentenceCaseItem = {
  form: string;
  lemma: string;
  partOfSpeech: PartOfSpeech;
  /** The saved meaning, in Hebrew. */
  translation: string;
  example: string;
  exampleTranslation: string;
  /** Gap only: words that would also fit the blank and so must never be offered. */
  fits?: string[];
  /** Sentence and translate: words whose presence shows the wrong sense. */
  offSense?: string[];
  /** Sentences of earlier sessions: in the learned language for a sentence card,
   *  in Hebrew for a translation card. */
  avoidTarget?: string[];
  avoidHebrew?: string[];
};

export type SentenceCase = {
  label: string;
  task: 'gap' | 'sentence' | 'translate';
  from: LanguageCode;
  items: SentenceCaseItem[];
  /** Phase 48 (spec D8). Also asks the real checker, and at least three wrong options must survive it. */
  checked?: boolean;
};

const word = (
  form: string,
  lemma: string,
  partOfSpeech: PartOfSpeech,
  translation: string,
  example: string,
  exampleTranslation: string,
  rest: Partial<SentenceCaseItem> = {},
): SentenceCaseItem => ({ form, lemma, partOfSpeech, translation, example, exampleTranslation, ...rest });

export const GAP_CASES: SentenceCase[] = [
  {
    label: 'gap it: a table could also be set, cleaned or reserved',
    task: 'gap',
    from: 'it',
    items: [
      word('prenotare', 'prenotare', 'verb', 'להזמין', 'Voglio prenotare un tavolo per due.', 'אני רוצה להזמין שולחן לשניים.', {
        fits: ['riservare', 'apparecchiare', 'pulire', 'preparare', 'sistemare'],
      }),
      word('parla', 'parlare', 'verb', 'לדבר', 'Lei parla tre lingue.', 'היא מדברת בשלוש שפות.', {
        fits: ['conosce', 'sa', 'studia', 'impara'],
      }),
      word('compro', 'comprare', 'verb', 'לקנות', 'Compro il pane ogni mattina.', 'אני קונה לחם כל בוקר.', {
        fits: ['mangio', 'prendo', 'taglio', 'faccio', 'vendo', 'preparo'],
      }),
    ],
  },
  {
    label: 'gap ru: a city has many good adjectives',
    task: 'gap',
    from: 'ru',
    items: [
      word('купить', 'купить', 'verb', 'לקנות', 'Я хочу купить хлеб.', 'אני רוצה לקנות לחם.', {
        fits: ['съесть', 'взять', 'испечь', 'заказать', 'нарезать', 'приготовить'],
      }),
      word('красивый', 'красивый', 'adjective', 'יפה', 'Это очень красивый город.', 'זו עיר יפה מאוד.', {
        fits: ['большой', 'старый', 'тихий', 'чистый', 'маленький', 'современный', 'древний'],
      }),
      word('лук', 'лук', 'noun', 'בצל', 'Я режу лук для супа.', 'אני חותך בצל למרק.', {
        fits: ['морковь', 'картошку', 'капусту', 'мясо', 'хлеб', 'сыр', 'чеснок', 'овощи'],
      }),
    ],
  },
  {
    // The brief's careless-word case: `I want to ___ a table` takes book, and clean fits too.
    label: 'gap en: a table could also be cleaned, set or reserved',
    task: 'gap',
    from: 'en',
    items: [
      word('book', 'book', 'verb', 'להזמין', 'I want to book a table.', 'אני רוצה להזמין שולחן.', {
        fits: ['clean', 'set', 'reserve', 'buy', 'wipe', 'paint', 'move', 'build'],
      }),
      word('begin', 'begin', 'verb', 'להתחיל', 'We begin at nine.', 'אנחנו מתחילים בתשע.', {
        fits: ['start', 'meet', 'leave', 'eat', 'finish', 'close', 'open', 'arrive'],
      }),
      word('tulip', 'tulip', 'noun', 'צבעוני', 'She planted a red tulip.', 'היא שתלה צבעוני אדום.', {
        fits: ['rose', 'flower', 'poppy', 'daisy', 'lily', 'geranium'],
      }),
    ],
  },
  {
    // Phase 48 (spec D8). Lane 0's 38b003b4: the model offered sugar, salt, oil, water, bread, fruit;
    // the checker said four fit, every attempt.
    label: 'gap en (38b003b4): anything goes in coffee — cream',
    task: 'gap',
    from: 'en',
    checked: true,
    items: [
      word('cream', 'cream', 'noun', 'שמנת', 'I like to put cream in my coffee.', 'אני אוהב לשים שמנת בקפה שלי.', {
        fits: ['sugar', 'milk', 'honey', 'salt', 'water', 'oil', 'cinnamon', 'butter', 'syrup', 'ice', 'whiskey', 'chocolate', 'cocoa', 'vanilla', 'caramel', 'lemon', 'spice', 'foam', 'sweetener'],
      }),
    ],
  },
];

/** Four words per language: two of several senses, one with sentences to avoid, one plain. */
const SENTENCE_WORDS: Record<'it' | 'ru' | 'en', SentenceCaseItem[]> = {
  it: [
    word('pianta', 'pianta', 'noun', 'צמח', 'Questa pianta ha bisogno di luce.', 'הצמח הזה צריך אור.', {
      offSense: ['mappa', 'cartina', 'piede', 'edificio', 'מפה', 'תוכנית', 'מפת'],
    }),
    word('campo', 'campo', 'noun', 'שדה', 'Il contadino lavora nel campo.', 'האיכר עובד בשדה.', {
      offSense: ['tenda', 'campeggio', 'accampamento', 'מחנה', 'אוהל', 'קמפינג'],
    }),
    word('prenotare', 'prenotare', 'verb', 'להזמין', 'Voglio prenotare un tavolo per due.', 'אני רוצה להזמין שולחן לשניים.', {
      avoidTarget: ['Devo prenotare un hotel per domani.'],
      avoidHebrew: ['אני צריך להזמין מלון למחר.'],
    }),
    word('parla', 'parlare', 'verb', 'לדבר', 'Lei parla tre lingue.', 'היא מדברת בשלוש שפות.'),
  ],
  ru: [
    word('ключ', 'ключ', 'noun', 'מפתח', 'Я потерял ключ от дома.', 'איבדתי את המפתח של הבית.', {
      offSense: ['родник', 'источник', 'родника', 'источника', 'מעיין', 'מעיינות', 'скрипичный'],
    }),
    word('лук', 'лук', 'noun', 'בצל', 'Я режу лук для супа.', 'אני חותך בצל למרק.', {
      offSense: ['стрела', 'стрелы', 'стрелять', 'лучник', 'קשת', 'חץ', 'חצים', 'לירות'],
    }),
    word('красивый', 'красивый', 'adjective', 'יפה', 'Это очень красивый город.', 'זו עיר יפה מאוד.', {
      avoidTarget: ['Она очень красивая девушка.'],
      avoidHebrew: ['היא ילדה יפה מאוד.'],
    }),
    word('говорит', 'говорить', 'verb', 'לדבר', 'Он говорит очень быстро.', 'הוא מדבר מהר מאוד.'),
  ],
  en: [
    word('book', 'book', 'verb', 'להזמין', 'I want to book a table.', 'אני רוצה להזמין שולחן.', {
      offSense: ['read', 'page', 'pages', 'novel', 'novels', 'library', 'ספר', 'ספרים', 'ספרייה'],
    }),
    word('run', 'run', 'verb', 'לנהל', 'She wants to run a small shop.', 'היא רוצה לנהל חנות קטנה.', {
      offSense: ['fast', 'marathon', 'race', 'jog', 'jogging', 'לרוץ', 'רצה', 'רץ', 'מרתון', 'ריצה'],
    }),
    word('bank', 'bank', 'noun', 'גדה', 'We sat on the bank of the river.', 'ישבנו על גדת הנהר.', {
      offSense: ['money', 'account', 'loan', 'cash', 'atm', 'בנק', 'כסף', 'חשבון', 'הלוואה'],
    }),
    word('begin', 'begin', 'verb', 'להתחיל', 'We begin at nine.', 'אנחנו מתחילים בתשע.', {
      avoidTarget: ['The class begins at ten.'],
      avoidHebrew: ['השיעור מתחיל בעשר.'],
    }),
  ],
};

const sentenceCases = (task: 'sentence' | 'translate'): SentenceCase[] =>
  (['it', 'ru', 'en'] as const).map((from) => ({
    label: `${task} ${from}: ${SENTENCE_WORDS[from].map((item) => item.form).join(', ')}`,
    task,
    from,
    items: SENTENCE_WORDS[from],
  }));

export const SENTENCE_CASES: SentenceCase[] = sentenceCases('sentence');
export const TRANSLATE_CASES: SentenceCase[] = sentenceCases('translate');

/**
 * Phase 27 Part B (spec D4). The translation judge: a Hebrew sentence, one good
 * reference, and an answer that is not the reference (the rule decides that one
 * without a call), with the verdict a careful teacher would give: exact is
 * "right", near_miss is "misspelled", alternative is "other_word".
 */
export type TranslationJudgeCase = {
  label: string;
  question: SentenceTranslationQuestion;
  context: JudgeContext;
  answer: string;
  expect: 'exact' | 'near_miss' | 'alternative' | 'wrong';
};

type Sentence = { hebrew: string; reference: string; gap: string };

const tjudge = (
  language: 'it' | 'ru' | 'en',
  practised: { form: string; lemma?: string; pos: PartOfSpeech; meaning: string },
  sentence: Sentence,
  answer: string,
  expect: TranslationJudgeCase['expect'],
  what: string,
): TranslationJudgeCase => {
  const start = sentence.reference.indexOf(sentence.gap);
  return {
    label: `tjudge ${language} ${what}: ${answer}`,
    question: {
      id: 'q',
      type: 'sentence_translation',
      vocab_term_id: 'v',
      question: sentence.hebrew,
      meaning: practised.meaning,
      sentence: sentence.reference,
      gap: { start, end: start + sentence.gap.length },
      answer: sentence.gap,
      mark: null,
    },
    context: {
      language,
      explanation: 'he',
      form: practised.form,
      lemma: practised.lemma ?? practised.form,
      partOfSpeech: practised.pos,
      meaning: practised.meaning,
      example: null,
      exampleTranslation: null,
    },
    answer,
    expect,
  };
};

const itTable: Sentence = { hebrew: 'אני רוצה להזמין שולחן לשניים.', reference: 'Voglio prenotare un tavolo per due.', gap: 'prenotare' };
const itYesterday: Sentence = { hebrew: 'הוא הזמין אתמול שולחן לשניים.', reference: 'Ieri ha prenotato un tavolo per due.', gap: 'prenotato' };
const itBook = { form: 'prenotare', pos: 'verb' as const, meaning: 'להזמין' };

const ruCity: Sentence = { hebrew: 'העיר הזאת יפה מאוד.', reference: 'Этот город очень красивый.', gap: 'красивый' };
const ruBeautiful = { form: 'красивый', pos: 'adjective' as const, meaning: 'יפה' };

const enTable: Sentence = { hebrew: 'אני רוצה להזמין שולחן לשניים.', reference: 'I want to book a table for two.', gap: 'book' };
const enYesterday: Sentence = { hebrew: 'הזמנתי אתמול שולחן לשניים.', reference: 'I booked a table for two yesterday.', gap: 'booked' };
const enBookWord = { form: 'book', pos: 'verb' as const, meaning: 'להזמין' };

// Phase 45 (spec D2). A manner word left out is a changed detail. Lane 0's card,
// and a held-out one on a word the prompt does not name.
const enClearly: Sentence = { hebrew: 'חשוב לתקשר בבירור עם כולם.', reference: 'It is important to communicate clearly with everyone.', gap: 'communicate' };
const enCommunicate = { form: 'communicate', pos: 'verb' as const, meaning: 'לתקשר' };
const ruFast: Sentence = { hebrew: 'הוא רץ מהר.', reference: 'Он быстро бегает.', gap: 'бегает' };
const ruRun = { form: 'бегать', pos: 'verb' as const, meaning: 'לרוץ' };

export const TRANSLATION_JUDGE_CASES: TranslationJudgeCase[] = [
  tjudge('it', itBook, itTable, 'Vorrei prenotare un tavolo per due persone.', 'exact', 'paraphrase'),
  tjudge('it', itBook, itTable, 'Desidero prenotare un tavolo per due.', 'exact', 'paraphrase'),
  tjudge('it', itBook, itYesterday, 'Ieri prenotò un tavolo per due.', 'exact', 'other tense of the word'),
  tjudge('it', itBook, itTable, 'Voglio prenottare un tavolo per due.', 'near_miss', 'misspelled word'),
  tjudge('it', itBook, itTable, 'Voglio riservare un tavolo per due.', 'alternative', 'other word'),
  tjudge('it', itBook, itTable, 'Voglio prenotato un tavolo per due.', 'wrong', 'wrong form of the word'),
  tjudge('it', itBook, itTable, 'Voglio prenotare una camera per tre.', 'wrong', 'missed meaning'),
  tjudge('it', itBook, itTable, 'Non capisco.', 'wrong', 'not a translation'),
  tjudge('it', itBook, itTable, 'Voglio prenotare un tavolo per dui.', 'exact', 'slip in another word'),

  tjudge('ru', ruBeautiful, ruCity, 'Этот город чрезвычайно красивый.', 'exact', 'paraphrase'),
  tjudge('ru', ruBeautiful, ruCity, 'Этот город очень, очень красивый.', 'exact', 'paraphrase'),
  tjudge('ru', ruBeautiful, ruCity, 'Этот город очень красив.', 'exact', 'short form of the word'),
  tjudge('ru', ruBeautiful, ruCity, 'Этот город очень красевый.', 'near_miss', 'misspelled word'),
  tjudge('ru', ruBeautiful, ruCity, 'Этот город очень прекрасный.', 'alternative', 'other word'),
  tjudge('ru', ruBeautiful, ruCity, 'Этот город очень красивая.', 'wrong', 'wrong form of the word'),
  tjudge('ru', ruBeautiful, ruCity, 'Этот город очень большой.', 'wrong', 'missed meaning'),
  tjudge('ru', ruBeautiful, ruCity, 'красивый', 'wrong', 'not a sentence'),
  tjudge('ru', ruBeautiful, ruCity, 'Этот горот очень красивый.', 'exact', 'slip in another word'),

  tjudge('en', enBookWord, enTable, "I'd like to book a table for two, please.", 'exact', 'paraphrase'),
  tjudge('en', enBookWord, enTable, 'I want to book a table for two people.', 'exact', 'paraphrase'),
  tjudge('en', enBookWord, enYesterday, 'I did book a table for two yesterday.', 'exact', 'other form of the word'),
  tjudge('en', enBookWord, enTable, 'I want to bok a table for two.', 'near_miss', 'misspelled word'),
  tjudge('en', enBookWord, enTable, 'I want to reserve a table for two.', 'alternative', 'other word'),
  tjudge('en', enBookWord, enTable, 'I want to booking a table for two.', 'wrong', 'wrong form of the word'),
  tjudge('en', enBookWord, enTable, 'I want to book a table for four.', 'wrong', 'missed meaning'),
  tjudge('en', enBookWord, enTable, 'table', 'wrong', 'not a sentence'),
  tjudge('en', enBookWord, enTable, 'I want to book a tabel for two.', 'exact', 'slip in another word'),
  tjudge('en', enCommunicate, enClearly, 'It is important to talk with everyone.', 'wrong', 'manner word left out'),
  tjudge('en', enCommunicate, enClearly, "It's important to communicate clearly with everyone.", 'exact', 'contraction'),
  tjudge('en', enCommunicate, enClearly, 'It is important to talk clearly with everyone.', 'alternative', 'other word, every detail kept'),
  // Review M1. The detail rule must spare a slip in the manner word, a synonym of it,
  // and its other place.
  tjudge('en', enCommunicate, enClearly, 'It is important to communicate clerly with everyone.', 'exact', 'slip in the manner word'),
  tjudge('en', enCommunicate, enClearly, 'It is important to communicate plainly with everyone.', 'exact', 'synonym of the manner word'),
  tjudge('en', enCommunicate, enClearly, 'It is important to clearly communicate with everyone.', 'exact', 'other adverb order'),
  tjudge('ru', ruRun, ruFast, 'Он бегает.', 'wrong', 'manner word left out'),
  tjudge('ru', ruRun, ruFast, 'Он бегает быстро.', 'exact', 'other word order'),
];

/**
 * Phase 34 (spec D1, D2). The accept call: every right answer to a typed or
 * spoken card whose prompt is one rendering, and the form of the headword that
 * agrees with it. Each case is a card from the audit
 * (drafts/2026-10-11-ambiguous-questions-findings.md, B, D and G), with its
 * rendering and saved example as lane 0 holds them. The prompt's own examples
 * are deliberately not these, so the cases measure the rules rather than recall.
 */
export type AcceptCase = {
  label: string;
  form: string;
  lemma: string;
  partOfSpeech: PartOfSpeech;
  /** The explanation-language text the card shows. */
  rendering: string;
  example: string | null;
  exampleTranslation: string | null;
  target: LanguageCode;
  /** Defaults to he. */
  explanation?: LanguageCode;
  /** Each must be accepted, by the typed judge, from the answers the server keeps. */
  expectAnswers?: string[];
  /** No answer as the model wrote it may contain one: a placeholder written out. */
  rejectSubstrings?: string[];
  /** The answer form the server keeps; null for a form that already agrees. */
  expectAnswerForm?: string | null;
};

export const ACCEPT_CASES: AcceptCase[] = [
  // B, 324633b1: four other cards for this prompt accept `frate`, this one did not.
  {
    label: 'B: a religious brother is also frate',
    form: 'fratello', lemma: 'fratello', partOfSpeech: 'noun', target: 'it',
    rendering: 'אח (במסדר דתי)',
    example: 'Il fratello francescano ha dedicato la sua vita alla preghiera.',
    exampleTranslation: 'האח הפרנציסקני הקדיש את חייו לתפילה.',
    expectAnswers: ['frate'],
  },
  // B, 703a58ca: 89b4bb33 accepted `allora` for the same prompt, this one refused it.
  {
    label: 'B: אז as "in that case" is also allora',
    form: 'poi', lemma: 'poi', partOfSpeech: 'adverb', target: 'it',
    rendering: 'אז',
    example: 'Se non vuoi venire, poi non lamentarti.',
    exampleTranslation: 'אם אינך רוצה לבוא, אז אל תתלונן.',
    expectAnswers: ['allora'],
  },
  // D, 5d9e4f97: `io ho`, the form with the pronoun יש לי implies, was marked wrong.
  {
    label: 'D: the subject pronoun יש לי implies',
    form: 'ho', lemma: 'avere', partOfSpeech: 'verb', target: 'it',
    rendering: 'יש לי',
    example: 'Ho un libro interessante da leggere.',
    exampleTranslation: 'יש לי ספר מעניין לקרוא.',
    expectAnswers: ['io ho'],
  },
  // B, 7d96a0c2: "lose one's temper" was listed; `lose my temper` was marked wrong.
  {
    label: "B: a placeholder written out, never one's",
    form: 'blow up', lemma: 'blow up', partOfSpeech: 'verb', target: 'en',
    rendering: 'להתפרץ בכעס',
    example: "My boss will blow up if I'm late again.",
    exampleTranslation: 'הבוס שלי יתפרץ בכעס אם אאחר שוב.',
    expectAnswers: ['lose my temper'],
    rejectSubstrings: ["one's", 'one’s', 'someone'],
  },
  // G, 2260df83: שעות from "per ore" asked for the singular `ora`.
  {
    label: 'G: a plural rendering asks for the plural form',
    form: 'ora', lemma: 'ora', partOfSpeech: 'noun', target: 'it',
    rendering: 'שעות',
    example: 'Abbiamo aspettato per ore.',
    exampleTranslation: 'חיכינו שעות.',
    expectAnswerForm: 'ore',
  },
  // The counterweight, and it must stay green: a card built from שעה still asks
  // for `ora` (spec D2). A prompt that pluralises everything shows up here.
  {
    label: 'G: a singular rendering keeps the form',
    form: 'ora', lemma: 'ora', partOfSpeech: 'noun', target: 'it',
    rendering: 'שעה',
    example: "La lezione dura un'ora.",
    exampleTranslation: 'השיעור נמשך שעה.',
    expectAnswerForm: null,
  },
];

/**
 * Phase 34 (spec D6, D8; ruling R3). The context call, one card each, as
 * prepareSession asks it. Scored on structure (contextChecks.ts): tier 1 that
 * the sentence and its other half are in the right scripts; tier 2 that the
 * server's own rules keep the sentence (contextItemFor and resolveContext, so a
 * target sentence shows the card's form and a Hebrew one holds no answer), that
 * the marked word is a form of the card's word, that the hidden Hebrew holds a
 * form of the rendering's root and none of another word's forms, and that a
 * sentence card's word is found in its Hebrew. The checker's own reading of the
 * sense is Task 6's case.
 */
export type ContextCase = {
  label: string;
  target: LanguageCode;
  /** The card the sentence is for. */
  type: QuestionType;
  form: string;
  lemma: string;
  partOfSpeech: PartOfSpeech;
  /** The rendering, in Hebrew. */
  translation: string;
  example: string | null;
  exampleTranslation: string | null;
  acceptedAnswers?: string[];
  /** A bare-word card: context_word must begin like one of these. */
  formsOf?: string[];
  /** A bare-word card: some word of the hidden Hebrew, with or without a
   *  one-letter prefix, matches this (a form of the rendering's root). */
  translationRoot?: RegExp;
  /** ...and none of them is one of these (another word's forms: ראה's for saw). */
  translationNotWords?: string[];
  /** A sentence card: its Hebrew, its target sentence and the practised word,
   *  and the Hebrew word that stands for it. */
  sentence?: { hebrew: string; target: string; word: string; marked: string };
};

/** לנסר's root in any form: לנסר, ינסר, מנסר, נוסר, ניסר, נסרתי. */
const SAW_ROOT = /נ[יו]?סר/u;
/** ראה's forms, the past of see read as Hebrew. */
const SEE_FORMS = ['ראה', 'ראיתי', 'ראית', 'ראתה', 'ראינו', 'ראיתם', 'ראו', 'רואה', 'רואים', 'רואות', 'יראה', 'תראה', 'אראה', 'לראות'];

export const CONTEXT_CASES: ContextCase[] = [
  // E, 71b0b407: `saw` is the tool's verb here, never the past of see.
  {
    label: 'context E: saw/לנסר in a sentence that shows saw, never see',
    target: 'en', type: 'typed_meaning', form: 'saw', lemma: 'saw', partOfSpeech: 'verb', translation: 'לנסר',
    example: 'He will saw the branch off the tree.', exampleTranslation: 'הוא ינסר את הענף מהעץ.',
    formsOf: ['saw'], translationRoot: SAW_ROOT, translationNotWords: SEE_FORMS,
  },
  // H, a7d6bdb4: the same word on a multiple choice, with no saved example to lean on.
  {
    label: 'context H: saw/לנסר on a multiple choice, no saved example',
    target: 'en', type: 'multiple_choice', form: 'saw', lemma: 'saw', partOfSpeech: 'verb', translation: 'לנסר',
    example: null, exampleTranslation: null,
    formsOf: ['saw'], translationRoot: SAW_ROOT, translationNotWords: SEE_FORMS,
  },
  // C, d388f738: a Hebrew sentence for להוריד that holds no English word.
  {
    label: 'context C: להוריד/download in a Hebrew sentence with no English word',
    target: 'en', type: 'typed_translation', form: 'download', lemma: 'download', partOfSpeech: 'verb', translation: 'להוריד',
    example: 'I need to download the file before the meeting.', exampleTranslation: 'אני צריך להוריד את הקובץ לפני הפגישה.',
    acceptedAnswers: ['get'],
  },
  // F, eb95d246: the practised word, named in the sentence the card shows.
  {
    label: 'context F: combine named in בואו נשלב כוחות',
    target: 'en', type: 'sentence_translation', form: 'combine', lemma: 'combine', partOfSpeech: 'verb', translation: 'לשלב',
    example: null, exampleTranslation: null,
    sentence: { hebrew: 'בואו נשלב כוחות.', target: "Let's combine forces.", word: 'combine', marked: 'נשלב' },
  },
];

/**
 * Phase 34 (spec D5; ruling R3). The checker, a second model reading the cards
 * as a learner would. One call per case, one item each, through the real
 * prompt and parser (askCheck). Tier 1 is that the answer reads (readCheck);
 * tier 2 that it means what a careful reader means, scored by the server's own
 * rules (wrongOnly, meaningFits, wordsFit, translationUses). Each kind has a
 * "no" beside its "yes": a checker that calls every option right fails the
 * blow up and pick up cases' wrong options and the gap's misfit, and one that
 * confirms every sentence fails "I saw him" and the volume's להוריד.
 */
export type CheckCase = {
  label: string;
  /** The language learned; the learner's own is Hebrew. */
  target: LanguageCode;
  item: CheckItem;
  /** A choice or gap item: per option, whether it is also right (or fits the gap). */
  alsoRight?: Record<string, boolean>;
  /** A target-language context: the gloss's meanings, which the reading must be one of to keep it. */
  glossMeanings?: string[];
  /** ...and the meanings it must not be read as (another word's). */
  notMeanings?: string[];
  /** A Hebrew context: the card it is for, by whose judge a word the checker reads fits. */
  card?: TypedTarget;
  /** A sentence card: the practised word and its accepted answers. */
  practised?: string[];
  /** A context or sentence card: whether the server keeps it on this answer. */
  keep?: boolean;
};

const SAW_READINGS = ['לנסר', 'מסור', 'ראה', 'לראות'];

export const CHECK_CASES: CheckCase[] = [
  // 3c482348: blow up stored as לנפח; a learner picked להרוס ("blew up the bridge") and was marked wrong.
  {
    label: 'checker A (3c482348): blow up — להרוס is also right, לקפל and לשבור are not',
    target: 'en',
    item: { key: 'q1', task: 'choice', word: 'blow up', options: ['להרוס', 'לקפל', 'לשבור'] },
    alsoRight: { להרוס: true, לקפל: false, לשבור: false },
  },
  // c49ddbec: pick up stored as לענות (the phone); להרים is its other sense.
  {
    label: 'checker A (c49ddbec): pick up — להרים is also right, לכתוב and לשיר are not',
    target: 'en',
    item: { key: 'q1', task: 'choice', word: 'pick up', options: ['להרים', 'לכתוב', 'לשיר'] },
    alsoRight: { להרים: true, לכתוב: false, לשיר: false },
  },
  // A cloze choice: the sentence, not the word's meaning, makes an option right.
  {
    label: 'checker gap: unlocked still fits "She ___ the door", ate does not',
    target: 'en',
    item: { key: 'q1', task: 'gap', sentence: 'She ___ the door and walked in.', options: ['unlocked', 'ate', 'slept'] },
    alsoRight: { unlocked: true, ate: false, slept: false },
  },
  {
    label: 'checker gap (38b003b4): sugar still fits "put ___ in my coffee", chair and music do not',
    target: 'en',
    item: { key: 'q1', task: 'gap', sentence: 'I like to put ___ in my coffee.', options: ['sugar', 'chair', 'music'] },
    alsoRight: { sugar: true, chair: false, music: false },
  },
  // Ruling R3, 71b0b407: the sentence the context call wrote for saw on 2026-10-11 (CONTEXT_CASES' first).
  {
    label: 'checker E (71b0b407, ruling R3): saw/לנסר — the marked saw means לנסר, not ראה',
    target: 'en',
    item: { key: 'q1c', task: 'meaning', sentence: 'Can you saw this wood for me?', word: 'saw', candidates: SAW_READINGS },
    glossMeanings: ['לנסר'],
    notMeanings: ['ראה', 'לראות'],
    keep: true,
  },
  {
    label: 'checker E: "I saw him at the station" is the past of see, and is dropped from a card for saw/לנסר',
    target: 'en',
    item: { key: 'q1c', task: 'meaning', sentence: 'I saw him at the station yesterday.', word: 'saw', candidates: SAW_READINGS },
    glossMeanings: ['לנסר'],
    keep: false,
  },
  // d388f738: להוריד is download in one sentence and turn down in another.
  {
    label: 'checker C (d388f738): להוריד the new game is download',
    target: 'en',
    item: { key: 'q1c', task: 'words', sentence: 'אני רוצה להוריד את המשחק החדש הלילה.', word: 'להוריד' },
    card: { answer: 'download', lemma: 'download', alternatives: ['get'] },
    keep: true,
  },
  {
    label: 'checker C: תוריד את הווליום is not download, and is dropped from a card for download',
    target: 'en',
    item: { key: 'q1c', task: 'words', sentence: 'תוריד את הווליום, בבקשה.', word: 'תוריד' },
    card: { answer: 'download', lemma: 'download', alternatives: ['get'] },
    keep: false,
  },
  // eb95d246: a learner wrote "lets work together" and got only "alternative".
  {
    label: 'checker F (eb95d246): בואו נשלב כוחות is said without combine, so the card is not a combine card',
    target: 'en',
    item: { key: 'q1', task: 'translate', sentence: 'בואו נשלב כוחות.' },
    practised: ['combine'],
    keep: false,
  },
  {
    label: 'checker F: a sentence whose practised word is the natural one is kept',
    target: 'en',
    item: { key: 'q1', task: 'translate', sentence: 'אני שותה קפה כל בוקר.' },
    practised: ['coffee'],
    keep: true,
  },
  // The server's candidates are the gap's text as the reference writes it, the form and the lemma.
  {
    label: 'checker F: an everyday verb is kept, in the past its sentence needs',
    target: 'en',
    item: { key: 'q1', task: 'translate', sentence: 'הוא קנה מכונית חדשה אתמול.' },
    practised: ['bought', 'buy'],
    keep: true,
  },
  // Review, fix round 1: Italian elides a preposition onto a vowel-initial word
  // (all'università), and the word is still found.
  {
    label: "checker F: an Italian word behind an elided preposition is kept (all'università)",
    target: 'it',
    item: { key: 'q1', task: 'translate', sentence: 'הלכתי לאוניברסיטה אתמול בבוקר.' },
    practised: ['università'],
    keep: true,
  },
];

/**
 * Phase 41 (spec D2). Whether a word the card's list missed fills a typed gap,
 * the sentence read alone. Each case is tier 2: a verdict either way is a call
 * the card then records.
 */
export type FitJudgeCase = {
  label: string;
  question: ClozeTypedQuestion;
  language: LanguageCode;
  answer: string;
  expect: 'fits' | 'wrong';
};

const fit = (language: LanguageCode, sentence: string, gap: string, answer: string, expect: FitJudgeCase['expect'], what: string): FitJudgeCase => {
  const start = sentence.indexOf(gap);
  return {
    label: `fit ${language} ${what}: ${answer}`,
    question: {
      id: 'q',
      type: 'cloze_typed',
      vocab_term_id: 'v',
      sentence,
      gap: { start, end: start + gap.length },
      translation: '',
      meaning: '',
      answer: gap,
      alternatives: [],
      mark: null,
    },
    language,
    answer,
    expect,
  };
};

const enFile = 'Please download the file.';
const enReading = 'She is reading a book in the garden.';
const itHouse = 'Abbiamo comprato una nuova casa al mare.';
const ruBought = 'Она купила новую машину вчера.';

export const FIT_JUDGE_CASES: FitJudgeCase[] = [
  // The bug that opened the phase: an open sentence, a common verb the list missed.
  fit('en', enFile, 'download', 'edit', 'fits', 'another verb'),
  fit('en', enFile, 'download', 'upload', 'fits', 'the opposite verb'),
  fit('en', enFile, 'download', 'print', 'fits', 'another verb'),
  fit('en', enFile, 'download', 'downloads', 'wrong', 'a form the gap cannot take'),
  fit('en', enFile, 'download', 'banana', 'wrong', 'a noun'),
  fit('en', enReading, 'reading', 'writing', 'fits', 'another verb'),
  fit('en', enReading, 'reading', 'read', 'wrong', 'a form the gap cannot take'),
  fit('en', enReading, 'reading', 'holding', 'fits', 'another meaning, still correct'),
  fit('en', enReading, 'reading', 'eating', 'wrong', 'a sentence that makes no sense'),
  // Gender and number decide in Italian and Russian.
  fit('it', itHouse, 'casa', 'macchina', 'fits', 'another feminine noun'),
  fit('it', itHouse, 'casa', 'barca', 'fits', 'another feminine noun'),
  fit('it', itHouse, 'casa', 'fiore', 'wrong', 'a masculine noun'),
  fit('it', itHouse, 'casa', 'case', 'wrong', 'the plural'),
  fit('ru', ruBought, 'купила', 'продала', 'fits', 'another verb, same agreement'),
  fit('ru', ruBought, 'купила', 'купил', 'wrong', 'the masculine past'),
  fit('ru', ruBought, 'купила', 'купить', 'wrong', 'the infinitive'),
];

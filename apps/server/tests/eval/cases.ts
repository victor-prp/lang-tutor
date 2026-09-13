import type { TranslationDirection, TranslationKind } from '@lang-tutor/core/api';

/**
 * Each case stresses one property of the prompt. `acceptTop` is a *set*, not a
 * string: a rewording must not fail a case, only a wrong meaning should.
 */
export type EvalCase = {
  label: string;
  text: string;
  direction?: TranslationDirection;
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
  },
  {
    label: 'the reverse direction, and that script detection agreed',
    text: 'מזלג',
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
  },
  {
    label: 'gibberish returns nothing rather than an invented translation',
    text: 'asdkjhasd',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
  },
];

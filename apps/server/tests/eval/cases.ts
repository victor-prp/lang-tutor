import type { PartOfSpeech, TranslationDirection, TranslationKind } from '@lang-tutor/core/api';

import type { StoredSense } from '../../src/domain/translation';

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
  direction?: TranslationDirection;
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
  // The phase 13 defect, reduced to its two inputs. `press`/verb holds these
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

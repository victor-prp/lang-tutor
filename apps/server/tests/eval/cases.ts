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
};

export const CASES: EvalCase[] = [
  {
    label: 'ranking: the common sense first, the rarer one still present',
    text: 'book',
    expectKind: 'word',
    acceptTop: ['ספר'],
    expectAlso: ['להזמין', 'הזמנה', 'לשריין'],
  },
  {
    label: 'ranking: a homonym with an unrelated second sense',
    text: 'bank',
    expectKind: 'word',
    acceptTop: ['בנק'],
    expectAlso: ['גדה', 'גדת הנהר', 'שפה'],
  },
  {
    label: 'senses spanning parts of speech',
    text: 'light',
    expectKind: 'word',
    acceptTop: ['אור'],
    expectAlso: ['קל', 'בהיר', 'להדליק'],
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
  {
    label: 'an inflected form still resolves',
    text: 'running',
    expectKind: 'word',
    acceptTop: ['ריצה', 'לרוץ', 'רץ'],
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
  {
    label: 'gibberish returns nothing rather than an invented translation',
    text: 'asdkjhasd',
    expectKind: 'word',
    acceptTop: [],
    expectEmpty: true,
  },
];

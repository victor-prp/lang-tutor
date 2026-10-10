// Strings the seed does not contain, so each lookup reaches MockServer once and
// is written to the e2e database. The lexemes are new, so no reconciliation call.
// Four senses of two words, shared by every spec that saves and then practises them.
export const PROCHITALA = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'прочитать',
      part_of_speech: 'verb',
      senses: [
        { translation: 'קראה', sense_code: 'read_through' },
        { translation: 'הקריאה', sense_code: 'read_aloud' },
      ],
    },
  ],
};

export const LUK = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'лук',
      part_of_speech: 'noun',
      senses: [
        { translation: 'בצל', sense_code: 'onion' },
        { translation: 'קשת', sense_code: 'bow' },
      ],
    },
  ],
};

// One form, two lexemes: знать the verb (to know) and знать the noun (nobility).
// Used only by the merged-word test, so no other spec has it in the e2e database.
export const ZNAT = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'знать',
      part_of_speech: 'verb',
      senses: [{ translation: 'לדעת', sense_code: 'know' }],
    },
    {
      lemma: 'знать',
      part_of_speech: 'noun',
      senses: [{ translation: 'אצולה', sense_code: 'nobility' }],
    },
  ],
};

// Phase 23. Two senses of one five-letter form, so every card about it can be
// a typed card answered with a near miss (one swap needs five letters). Used
// only by question-types.spec.ts.
export const ZAMOK = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'замок',
      part_of_speech: 'noun',
      senses: [
        { translation: 'טירה', sense_code: 'castle' },
        { translation: 'מנעול', sense_code: 'lock' },
      ],
    },
  ],
};

/** Phase 24. Ten single-sense Russian nouns: none in the seed (checked against
 *  content.ts and content.generated.ts), each of five to eight letters so any
 *  can be a tiles card, each with its own meaning so any four make a board. */
const single = (form: string, translation: string, code: string) => ({
  form,
  translation,
  payload: { kind: 'word' as const, entries: [{ lemma: form, part_of_speech: 'noun', senses: [{ translation, sense_code: code }] }] },
});

export const BOARD_WORDS = [
  single('ромашка', 'מרגנית', 'daisy'),
  single('черепаха', 'צב', 'turtle'),
  single('подушка', 'כרית', 'pillow'),
  single('зонтик', 'מטרייה', 'umbrella'),
  single('ведро', 'דלי', 'bucket'),
  single('скрипка', 'כינור', 'violin'),
  single('лопата', 'את חפירה', 'shovel'),
  single('кастрюля', 'סיר', 'pot'),
  single('фонарь', 'פנס', 'lantern'),
  single('ящерица', 'לטאה', 'lizard'),
];

/** Phase 31. `mouse`: two senses, one Hebrew word, so one card with two examples.
 *  The rodent has one other word, which the lookup card and the word's page
 *  show as their "also" line. */
export const MOUSE = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'mouse',
      part_of_speech: 'noun',
      senses: [
        { translation: 'עכבר', gloss: 'עכבר', alternatives: ['עכברון'], definition: 'a small rodent with a long tail', sense_code: 'rodent', example: { source: 'A mouse ran across the kitchen floor.', target: 'עכבר רץ על רצפת המטבח.' } },
        { translation: 'עכבר', gloss: 'עכבר', definition: 'a hand-held device that moves a pointer', sense_code: 'computer_device', example: { source: 'Click the left mouse button.', target: 'לחץ על הכפתור השמאלי של העכבר.' } },
      ],
    },
  ],
};

/** Phase 31. `fingers`, saved inflected: a plural rendering, a singular citation form. */
export const FINGERS = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'finger',
      part_of_speech: 'noun',
      senses: [{ translation: 'אצבעות', gloss: 'אצבע', alternatives: [], definition: 'one of the five digits of the hand', sense_code: 'body_part', example: { source: 'He has long fingers.', target: 'יש לו אצבעות ארוכות.' } }],
    },
  ],
};

/** Phase 31. The render-lemma job's lookup of `finger`: the first call's answer
 *  (a new code), then the rendering call that maps it onto the stored sense. */
export const FINGER = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'finger',
      part_of_speech: 'noun',
      senses: [{ translation: 'אצבע', gloss: 'אצבע', definition: 'one of the five digits of the hand', sense_code: 'digit_of_hand', example: { source: 'She pointed with one finger.', target: 'היא הצביעה באצבע אחת.' } }],
    },
  ],
};
export const FINGER_RECONCILED = {
  senses: [{ sense_code: 'body_part', translation: 'אצבע', gloss: 'אצבע', definition: null, example: { source: 'She pointed with one finger.', target: 'היא הצביעה באצבע אחת.' } }],
};

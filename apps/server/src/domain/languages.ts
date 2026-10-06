/**
 * Every language the server knows, in one table: what script its letters are
 * in, and what the model must be told about it. The script guard, the prompt
 * builders, the corrected-form guard and the seed's content tests all read
 * this table, so adding a language is one entry here.
 *
 * Pure data under ADR 0001 R3. `LanguageCode` is declared here rather than
 * imported from packages/core so this module has no dependency at all; the
 * wire's `LanguageCodeSchema` names the same codes, and
 * services/translations.ts is where the two meet and the compiler checks them.
 *
 * Every rule string here goes into the prompt's system instruction, which is
 * part of the request body MockServer matches against. None may contain the
 * unquoted substrings `see` or `saw` — see the comment in `buildPrompt`, and
 * the test that enforces it.
 */
export type LanguageCode = 'he' | 'en' | 'ru' | 'it';

export type Language = {
  code: LanguageCode;
  /** The English name, as the prompt says it. */
  name: string;
  /** Matches ONE letter of this language's script. Marks (nikud, stress) are
   *  not letters, so they never decide anything. */
  letters: RegExp;
  /** How to read input typed in this language: which headword a form belongs
   *  to. Takes the target language's name because a rule may say what it
   *  translates into. */
  asSource: (targetName: string) => string[];
  /** How to write a translation into this language. */
  asTarget: string[];
  /** How to write this language at all. It applies whenever the call writes
   *  it, which is both directions, because every example has both halves. */
  writing: string[];
};

export const LANGUAGES: Record<LanguageCode, Language> = {
  he: {
    code: 'he',
    name: 'Hebrew',
    letters: /\p{Script=Hebrew}/u,
    asSource: () => [],
    asTarget: [
      'For Hebrew past tense that citation form is third-person masculine singular.',
      'A Hebrew infinitive keeps its ל: להזמין, never הזמין.',
    ],
    // "citation form" reads to the model as "how a dictionary prints it", and
    // a printed Hebrew dictionary prints nikud. That cost a recording of סֵפֶר
    // where every consumer expects ספר.
    writing: ['Write Hebrew in plain unvocalised script, with no nikud: ספר, never סֵפֶר.'],
  },
  en: {
    code: 'en',
    name: 'English',
    letters: /\p{Script=Latin}/u,
    asSource: (targetName) => [
      `A bare or "to"-marked English verb — "book", "to book" — is the base form and takes the ${targetName} infinitive.`,
    ],
    asTarget: [],
    writing: [],
  },
  ru: {
    code: 'ru',
    name: 'Russian',
    letters: /\p{Script=Cyrillic}/u,
    // Aspect is the likeliest miss: a model "helpfully" returns the
    // imperfective. The eval case `прочитала` is aimed at exactly this.
    asSource: () => [
      'A Russian noun belongs to its nominative singular, an adjective to its masculine',
      'nominative singular, and a verb to the infinitive of the aspect typed: "прочитала"',
      'belongs to "прочитать", never to "читать".',
      // Measured: without it the model read `елка` as an accepted spelling —
      // print often omits the dots — and answered with no correction, so the
      // writing rule's "never елка" governs only what the model writes. The
      // exception keeps `все` (all) from being "corrected" to `всё`.
      'A Russian word typed with е where its spelling has ё is a misspelling: correct it to',
      'the spelling with ё. This does not apply when the е spelling is itself a different',
      'word, as все is beside всё.',
    ],
    asTarget: ['For Russian past tense that citation form is masculine singular.'],
    writing: [
      'Write Russian without stress marks: молоко, never молоко́.',
      'Write ё wherever the word has it: ёлка, never елка.',
    ],
  },
  it: {
    code: 'it',
    name: 'Italian',
    // The same script as English. The guard cannot tell the two apart and does
    // not try: the client states the pair, and English typed under it → he
    // reaches the model's third-language rule (phase 22 spec, D2).
    letters: /\p{Script=Latin}/u,
    // The examples are deliberately not the eval cases (parlo, libri, bella,
    // perche, citta), so the evals measure the rule rather than recall of the
    // example.
    asSource: () => [
      'An Italian noun belongs to its singular, an adjective to its masculine singular, and a',
      'verb to its infinitive: "scrivevo" belongs to "scrivere", "case" to "casa", "rosse" to',
      '"rosso". A pronominal verb takes its -si infinitive: "mi chiamo" belongs to "chiamarsi".',
      // The counterpart of Russian's ё rule. Phone keyboards drop accents, and
      // phase 13's correction path is what turns `piu` into `più` for good. The
      // exception keeps `e` (and) from being "corrected" to `è` (is).
      'An Italian word typed without its written accent is a misspelling: correct "piu" to',
      '"più" and "gia" to "già". This does not apply when the unaccented spelling is itself a',
      'different word, as e is beside è and la beside là.',
    ],
    // Italian has several past tenses. The passato prossimo is the one of
    // everyday speech, which is what a beginner meets (spec D5).
    asTarget: [
      'For Italian past tense that citation form is the passato prossimo, third-person masculine',
      'singular: "ha scritto", "è partito".',
    ],
    writing: ['Write Italian with every accent its spelling has, grave or acute: però, così, più.'],
  },
};

export type ScriptVerdict = 'pass' | 'wrong_direction' | 'out_of_pair';

const ANY_LETTER = /\p{L}/gu;

function lettersOf(text: string): string[] {
  return text.match(ANY_LETTER) ?? [];
}

/**
 * Whether a lookup's input belongs to its `from` side, decided before any read
 * or model call (spec §3). One letter of `from`'s script is enough to pass, so
 * mixed input such as `ה-NBA` reaches the model; input with no letters at all
 * (`100%`) passes too, because there is nothing to judge.
 */
export function guardScript(text: string, from: LanguageCode, to: LanguageCode): ScriptVerdict {
  const letters = lettersOf(text);
  if (letters.length === 0) return 'pass';
  if (letters.some((letter) => LANGUAGES[from].letters.test(letter))) return 'pass';
  if (letters.every((letter) => LANGUAGES[to].letters.test(letter))) return 'wrong_direction';
  return 'out_of_pair';
}

/** Every letter is in `code`'s script. Vacuously true with no letters. */
export function isInScript(text: string, code: LanguageCode): boolean {
  return lettersOf(text).every((letter) => LANGUAGES[code].letters.test(letter));
}

/**
 * Removes U+0301 (combining acute) after a Cyrillic letter: `молоко́` and
 * `молоко` are one dictionary key. Stress is a reading aid, not spelling, and
 * native text never writes it. Deliberately narrow: a Latin accent (`café`,
 * decomposed) and Hebrew points are spelling and survive, and `ё` is a letter,
 * not a stress mark — `елка` is a misspelling of `ёлка`, handled by phase 13's
 * correction path rather than folded here.
 */
export function stripStress(text: string): string {
  return text.replace(/(\p{Script=Cyrillic})\u0301/gu, '$1');
}

import { LlmSenseMatchSchema } from '@lang-tutor/core/api/schemas';
import { normaliseGloss } from '@lang-tutor/core/domain';

import { LANGUAGES, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 26 (spec D7). Which of a word's senses the Hebrew printed beside it
 * names. A free check first: any printed gloss equal to a sense's translation.
 * Only when that finds nothing is the model asked, through LlmClient.
 *
 * Phase 31. A sense is a gloss card now, so the free check reads the card's key
 * and its alternatives as well as its translation, the translation and the key
 * before the alternatives, and "equal" is the gloss key's rule (normaliseGloss),
 * bar a sentence mark at the end of a word.
 */

/** In the instruction verbatim, so MockServer can tell this call apart. */
export const SENSE_MATCH_MARKER = 'which numbered sense';

/** A gloss card as the matcher reads it. `key` is the gloss's own, which a card
 *  carries only when it differs from `translation` (a typed form's rendering). */
export type MatchOption = { translation: string; key?: string; alternatives?: readonly string[]; part_of_speech?: string };
export type MatchedBy = 'exact' | 'model' | 'none' | 'no_hebrew';
export type SenseChoice = { index: number; mismatch: boolean; matchedBy: MatchedBy };

export type SenseMatchPrompt = {
  system: string;
  user: string;
  schema: typeof LlmSenseMatchSchema;
};

// A list prints "מכונית." as readily as "מכונית". normaliseGloss keeps a mark at
// the end of a word, and `comparable` (the session's idea of "the same Hebrew")
// drops it, so folding with normaliseGloss alone would turn a full stop into a
// model call. This is `comparable`'s class, white space included.
const TRAILING_MARKS = /[\s.,;:!?…،؛؟]+$/u;

/** One word of a printed translation or of a card, as the free check compares
 *  it: a mark at its end dropped, then folded with normaliseGloss, the rule
 *  that makes two target words one gloss. */
const wordKey = (word: string): string => normaliseGloss(word.replace(TRAILING_MARKS, ''));

/** A printed translation's words: `בנק, גדה / שפה` is three. Notes in brackets go
 *  first, as splitTranslation drops them, so a comma inside one never splits;
 *  each word is then folded by wordKey. */
export function glossesOf(hebrew: string): string[] {
  return hebrew
    .replace(/\([^)]*\)/gu, '')
    .split(/[,/;]/u)
    .map(wordKey)
    .filter((gloss) => gloss.length > 0);
}

export function firstChoice(hebrew: string | null, options: readonly MatchOption[]): SenseChoice | 'ask_model' {
  if (hebrew === null) return { index: 0, mismatch: false, matchedBy: 'no_hebrew' };
  const printed = new Set(glossesOf(hebrew));
  const named = (words: readonly (string | undefined)[]): boolean =>
    words.some((word) => word !== undefined && printed.has(wordKey(word)));
  // Phase 31: a card's other words name it too, so a printed רכב finds מכונית. A
  // card's own words, its translation and its key, name it before those do, so an
  // earlier card that only lists the printed word never beats a later card that
  // is it. Within a tier the lookup's order decides.
  const own = options.findIndex((option) => named([option.translation, option.key]));
  const index = own !== -1 ? own : options.findIndex((option) => named(option.alternatives ?? []));
  return index === -1 ? 'ask_model' : { index, mismatch: false, matchedBy: 'exact' };
}

export function buildSenseMatchPrompt(input: {
  word: string;
  target: LanguageCode;
  hebrew: string;
  options: readonly MatchOption[];
}): SenseMatchPrompt {
  const name = LANGUAGES[input.target].name;
  const system = [
    `A word list printed the ${name} word below with a Hebrew translation. Decide ${SENSE_MATCH_MARKER} of the word the printed Hebrew names.`,
    'Return JSON only, matching the supplied schema.',
    "Answer with that sense's number. Answer 0 when the printed Hebrew names none of the senses.",
    'A sense matches when the printed Hebrew means the same thing, even in other words or another form: a synonym, another gender or number, a longer phrase, or with or without an article or a preposition.',
  ].join('\n');
  const user = JSON.stringify({
    word: input.word,
    printed_hebrew: input.hebrew,
    senses: input.options.map((option, index) => ({
      number: index + 1,
      hebrew: option.translation,
      ...(option.alternatives?.length ? { also: option.alternatives } : {}),
      ...(option.part_of_speech ? { part_of_speech: option.part_of_speech } : {}),
    })),
  });
  return { system, user, schema: LlmSenseMatchSchema };
}

/** An index into the options; `'none'` for 0, a number out of range, or the
 *  provider's empty "no content"; `null` when unreadable, which the job turns
 *  into a retry. */
export function parseSenseMatch(raw: string, optionCount: number): number | 'none' | null {
  if (raw === '') return 'none';
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmSenseMatchSchema.safeParse(dropNulls(json));
  if (!result.success) return null;
  const sense = result.data.sense;
  return sense >= 1 && sense <= optionCount ? sense - 1 : 'none';
}

/** "None" falls back to the most common sense, flagged (spec D7). */
export function choiceFromModel(answer: number | 'none'): SenseChoice {
  return answer === 'none'
    ? { index: 0, mismatch: true, matchedBy: 'none' }
    : { index: answer, mismatch: false, matchedBy: 'model' };
}

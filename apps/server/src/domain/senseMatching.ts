import { LlmSenseMatchSchema } from '@lang-tutor/core/api/schemas';

import { comparable } from './distractors';
import { LANGUAGES, type LanguageCode } from './languages';
import { dropNulls, unfence } from './translation';

/**
 * Phase 26 (spec D7). Which of a word's senses the Hebrew printed beside it
 * names. A free check first: any printed gloss equal to a sense's translation.
 * Only when that finds nothing is the model asked, through LlmClient.
 */

/** In the instruction verbatim, so MockServer can tell this call apart. */
export const SENSE_MATCH_MARKER = 'which numbered sense';

export type MatchOption = { translation: string; part_of_speech?: string };
export type MatchedBy = 'exact' | 'model' | 'none' | 'no_hebrew';
export type SenseChoice = { index: number; mismatch: boolean; matchedBy: MatchedBy };

export type SenseMatchPrompt = {
  system: string;
  user: string;
  schema: typeof LlmSenseMatchSchema;
};

/** A printed translation's glosses: `בנק, גדה / שפה` is three. Folded with
 *  `comparable`, the session's own idea of "the same Hebrew". */
export function glossesOf(hebrew: string): string[] {
  return hebrew
    .split(/[,/;]/u)
    .map(comparable)
    .filter((gloss) => gloss.length > 0);
}

export function firstChoice(hebrew: string | null, options: readonly MatchOption[]): SenseChoice | 'ask_model' {
  if (hebrew === null) return { index: 0, mismatch: false, matchedBy: 'no_hebrew' };
  const glosses = new Set(glossesOf(hebrew));
  const index = options.findIndex((option) => glosses.has(comparable(option.translation)));
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

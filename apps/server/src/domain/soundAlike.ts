import { LlmSoundAlikeSchema } from '@lang-tutor/core/api/schemas';
import type { SoundPair } from '@lang-tutor/core/domain';

import { LANGUAGES, type LanguageCode } from './languages';
import { unfence } from './translation';

/**
 * Phase 50 (spec D2). The pure half of the second look at an unheard
 * transcript: how alike two written words sound, 0 to 1. The call sees no
 * audio, so it cannot hear the expected word into the clip (phase 25 D1): the
 * hearing is over, and its transcript is kept as it is. services/sessions.ts
 * reads and stores the scores and decides what a failure costs.
 */

/** In the instruction verbatim, so MockServer can tell this call apart.
 *  Changing the wording means changing the stubs. */
export const SOUND_ALIKE_MARKER = 'how alike they sound';

/** Spec D4 (Victor, 2026-10-14). The score at which a pair is the same word. */
export const DEFAULT_SOUND_ALIKE_THRESHOLD = 0.95;

/** Spec D3. A pair as it is stored and asked: `a < b`, so (sell, cell) and
 *  (cell, sell) are one row and one question. */
export type OrderedPair = { a: string; b: string };

export function orderedPair(pair: SoundPair): OrderedPair {
  return pair.heard < pair.form ? { a: pair.heard, b: pair.form } : { a: pair.form, b: pair.heard };
}

/** Spec D4. SOUND_ALIKE_THRESHOLD, or the default for anything not in (0, 1]. */
export function soundAlikeThreshold(value: string | undefined): number {
  const threshold = Number(value);
  return threshold > 0 && threshold <= 1 ? threshold : DEFAULT_SOUND_ALIKE_THRESHOLD;
}

/** Structurally LlmJsonRequest; services/sessions.ts is where the two meet. */
export type SoundAlikePrompt = { system: string; user: string; schema: typeof LlmSoundAlikeSchema };

const key = (index: number) => `p${index + 1}`;

export function buildSoundAlikePrompt(language: LanguageCode, pairs: readonly OrderedPair[]): SoundAlikePrompt {
  const name = LANGUAGES[language].name;
  // The examples are deliberately not the eval's cases, as accept.ts's are
  // not, so the eval measures the rule rather than recall of it.
  const system = [
    `Your task: for each pair of ${name} words or phrases, score ${SOUND_ALIKE_MARKER} when each is said aloud in the standard pronunciation of ${name}.`,
    'Compare the sounds only: spelling and meaning do not count.',
    'Score from 0 to 1:',
    '- 1: said exactly the same, sound for sound, though spelled differently, as "pair" and "pear" are.',
    '- about 0.8: one sound differs: a vowel\'s quality or length, a consonant\'s voicing, one consonant for another, or a consonant held long or short, as in "fill" and "feel", "pig" and "pick", "thin" and "tin", or Italian "nono" and "nonno".',
    'A difference a native listener can hear is never 1, however small: a doubled consonant is held longer, and "th" is not "t".',
    '- 0.5 or less: several sounds differ.',
    '- 0: nothing in common.',
    'Apply the ordinary rules of how the language is spoken, by which some different spellings are said the same: a final consonant that loses its voice, an unstressed vowel that changes, a letter that is silent.',
    ...(language === 'en' ? ['Two words said the same in either General American or Received Pronunciation score 1.'] : []),
    'Return JSON only, matching the supplied schema: in "scores", one entry for every pair, with its "key" and its "score".',
  ].join('\n');
  const user = JSON.stringify({ pairs: pairs.map((pair, index) => ({ key: key(index), a: pair.a, b: pair.b })) });
  return { system, user, schema: LlmSoundAlikeSchema };
}

/** One score per pair asked, in order: null for a pair the answer left out, or
 *  scored outside 0 to 1. Null as a whole when the answer cannot be read. */
export function parseSoundAlike(raw: string, count: number): (number | null)[] | null {
  if (raw.trim() === '') return null;
  try {
    const parsed = LlmSoundAlikeSchema.safeParse(JSON.parse(unfence(raw)));
    if (!parsed.success) return null;
    const keys = Array.from({ length: count }, (_, index) => key(index));
    const scores: (number | null)[] = keys.map(() => null);
    for (const { key: answered, score } of parsed.data.scores) {
      const index = keys.indexOf(answered.trim());
      if (index === -1 || scores[index] !== null || !(score >= 0 && score <= 1)) continue;
      scores[index] = score;
    }
    return scores;
  } catch {
    return null;
  }
}

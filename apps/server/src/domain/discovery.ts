import type { DiscoveryLearningContext, DiscoverySelfLevel, PartOfSpeech } from '@lang-tutor/core/api';
import { LlmDiscoverySchema } from '@lang-tutor/core/api/schemas';

import { normalizeForm } from './dictionary';
import { LANGUAGES, stripStress, type LanguageCode } from './languages';
import { MAX_ITEM_LENGTH } from './photoReading';
import { dropNulls, unfence } from './translation';

/**
 * Phase 69. Words for me: the pure half. Where a learner's level starts and how a round
 * moves it (spec D3), what the model is asked for a round, and what its answer means
 * (spec D4). services/discovery.ts calls the model and keeps the run.
 *
 * The prompt lives here, as the photo reading's does, so `npm run eval` scores exactly
 * what production sends.
 */

/** In the instruction verbatim, so MockServer can tell this call from the others. */
export const DISCOVERY_MARKER = 'propose new words for a learner';

/** Spec D3. Two levels per CEFR band, A1 to C2. */
export const LEVEL_MIN = 1;
export const LEVEL_MAX = 12;

/** Spec D3. Where a learner's first run starts, from how much they say they know. */
export const FIRST_LEVEL: Readonly<Record<DiscoverySelfLevel, number>> = {
  none: 1,
  basic: 2,
  simple: 3,
  everyday: 5,
  fluent: 7,
};

/** Spec D3. A round cut short before this many answers keeps the level. */
export const SETTLE_MIN_ANSWERED = 4;

/** Spec D4. The model is asked for more than a round, so a round survives the drops. */
export const CANDIDATES = 14;
export const ROUND_SIZE = 10;

/** Spec D8. After this many rounds a run goes to its list. */
export const MAX_ROUNDS = 8;

/** Spec D4. The newest words to leave out that the prompt carries; the parser checks all. */
export const EXCLUDE_IN_PROMPT = 400;

/** Spec D6. */
export const GOAL_CHOICES = [5, 10, 15, 20, 30] as const;
export const DEFAULT_GOAL = 15;
export const MAX_GOAL = 30;

const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type Cefr = (typeof CEFR)[number];

export function firstLevel(self: DiscoverySelfLevel): number {
  return FIRST_LEVEL[self];
}

/**
 * Spec D3. The level after a round, from the share of its answered cards the learner
 * knew: at least 0.8 up two, at least 0.6 up one, over 0.2 the same, over 0 down one,
 * none down two. Counted in whole numbers, so 4 of 5 is exactly 0.8.
 */
export function levelAfter(level: number, answered: readonly { known: boolean }[]): number {
  const total = answered.length;
  if (total < SETTLE_MIN_ANSWERED) return level;
  const known = answered.filter((card) => card.known).length;
  let step: number;
  if (known * 10 >= total * 8) step = 2;
  else if (known * 10 >= total * 6) step = 1;
  else if (known * 10 > total * 2) step = 0;
  else if (known > 0) step = -1;
  else step = -2;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, level + step));
}

export function bandOf(level: number): { cefr: Cefr; half: 'lower' | 'upper' } {
  const clamped = Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, level));
  return { cefr: CEFR[Math.ceil(clamped / 2) - 1], half: clamped % 2 === 1 ? 'lower' : 'upper' };
}

/** A word as the dictionary keys it, lower-cased: `Gatto` and ` gatto ` are one word. */
export function wordKey(text: string): string {
  return normalizeForm(stripStress(text)).toLowerCase();
}

const CONTEXTS: Readonly<Record<DiscoveryLearningContext, string>> = {
  school: 'learns it at school: prefer words a school curriculum teaches at that age',
  course: 'learns it in a course or with a teacher: prefer course-book vocabulary',
  self: 'learns it alone: prefer practical everyday words',
  family: 'learns it at home or with family: prefer words of home and family talk',
};

export type DiscoveryPromptInput = {
  target: LanguageCode;
  level: number;
  age: number;
  learningContext: DiscoveryLearningContext;
  /** Newest first: the prompt carries the first EXCLUDE_IN_PROMPT. */
  exclude: readonly string[];
};

export function buildDiscoveryPrompt(input: DiscoveryPromptInput) {
  const name = LANGUAGES[input.target].name;
  const { cefr, half } = bandOf(input.level);
  const system = [
    `Your task: ${DISCOVERY_MARKER}. The learner speaks Hebrew and is learning ${name}.`,
    `Propose ${CANDIDATES} ${name} vocabulary items at CEFR ${cefr}, the ${half} half of it: words a learner at that level is likely not to know yet but needs next.`,
    'Return JSON only, matching the supplied schema.',
    'Rules:',
    '1. Mostly single words. A short fixed expression only when a dictionary lists it as one entry.',
    '2. Each item in its dictionary form: no article, a verb in its infinitive, a noun in the singular.',
    `3. Fit the learner's age (age): a child gets no adult topics. Fit how they learn (learning_context).`,
    '4. None of the words in exclude, in any form.',
    '5. No two items the same word.',
    '6. "hebrew" is the main meaning in Hebrew, without niqqud. "alternatives" holds other right Hebrew meanings of the item, possibly none.',
  ].join('\n');
  const user = JSON.stringify({
    language: name,
    level: `${cefr} ${half}`,
    age: input.age,
    learning_context: input.learningContext,
    about_the_learner: `The learner ${CONTEXTS[input.learningContext]}.`,
    exclude: input.exclude.slice(0, EXCLUDE_IN_PROMPT),
  });
  return { system, user, schema: LlmDiscoverySchema };
}

export type ProposedWord = { word: string; partOfSpeech: PartOfSpeech; hebrew: string; alternatives: string[] };

const HEBREW_LETTER = /[֐-׿]/;

/**
 * Spec D4. The words of a round: the model's, in its order, less any in Hebrew script,
 * empty, over-long, without a meaning, repeated, or to leave out, then the first
 * ROUND_SIZE. Null means the answer is not the schema. `dropped` counts what was left
 * out, for the round's log line.
 */
export function parseDiscovery(raw: string, exclude: ReadonlySet<string>): { words: ProposedWord[]; dropped: number } | null {
  let json: unknown;
  try {
    json = JSON.parse(unfence(raw));
  } catch {
    return null;
  }
  const result = LlmDiscoverySchema.safeParse(dropNulls(json));
  if (!result.success) return null;

  const seen = new Set<string>();
  const words: ProposedWord[] = [];
  let dropped = 0;
  for (const item of result.data.words) {
    const word = stripStress(item.word).replace(/\s+/g, ' ').trim();
    const hebrew = item.hebrew.trim();
    const key = wordKey(word);
    if (word === '' || word.length > MAX_ITEM_LENGTH || HEBREW_LETTER.test(word) || hebrew === '' || seen.has(key) || exclude.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    if (words.length < ROUND_SIZE) {
      words.push({
        word,
        partOfSpeech: item.part_of_speech,
        hebrew,
        alternatives: item.alternatives.map((alternative) => alternative.trim()).filter((alternative) => alternative !== ''),
      });
    }
  }
  return { words, dropped };
}

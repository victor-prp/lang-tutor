/**
 * Phase 20. How well a learner knows one saved sense, in five dimensions (spec
 * §1). In core rather than the server because the app shows the same ladder:
 * which dimensions are live, and how several levels become one badge.
 *
 * The wire publishes the same list as KnowledgeDimensionSchema. This module
 * cannot import it: core/domain is imported by the app at runtime, and the app
 * never loads Zod. progress.test.ts keeps the two equal.
 */
export const DIMENSIONS = [
  'written_receptive',
  'written_productive',
  'spoken_receptive',
  'spoken_productive',
  'spelling',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** The dimensions some question type feeds. Phase 23: the card, target word
 *  to Hebrew, evidences written_receptive; Hebrew to target, picked, adds
 *  written_productive (capped); typed adds spelling. The spoken two wait for
 *  voice. A badge is the mean over these, so going live recalibrates it once
 *  (phase 23 spec D7). */
export const LIVE_DIMENSIONS: readonly Dimension[] = ['written_receptive', 'written_productive', 'spelling'];

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;

/** The mean of `levels`, rounded to the nearest level, ties up. Mirrors
 *  `floor(avg(level) + 0.5)` in the list query. */
export function badge(levels: readonly number[]): number {
  if (levels.length === 0) throw new Error('a badge needs at least one level');
  const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length;
  return Math.floor(mean + 0.5);
}

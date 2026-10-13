import { gradesFor, review, type Dimension, type GradableAnswer, type MemoryState } from '@lang-tutor/core/domain';

import { KNOWN_STABILITY } from './chooseConstants';

/**
 * Phase 35 (spec D4, D8). The memory a session's answers leave behind. Pure: the
 * day is passed in (ADR 0001 R3). The live path (services/sessions.ts) and the
 * recompute (db/progressRecompute.ts) both run this one function.
 */

/** One row of gloss_memory: a gloss and dimension's FSRS state. Phase 46 (spec D1):
 *  `reachedOn` is the learner day its stability first reached KNOWN_STABILITY, kept
 *  after any later lapse; null until then. */
export type MemoryRow = { glossId: string; dimension: Dimension; state: MemoryState; reachedOn: string | null };

/** An answer about a gloss, as `gradesFor` reads it. */
export type GradedAnswer = GradableAnswer & { glossId: string };

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}\u0000${dimension}`;

/**
 * Applies the answers in order, each piece of each answer as one review on `day`.
 * `review` takes the long-term rule for a row last reviewed on an earlier day (or
 * a first review) and t = 0 for one already reviewed on `day`, so the first
 * review of a day is long-term and every later one is not, across sessions too.
 * Returns the rows that changed, in the order each was first touched. The caller
 * passes only answers about saved glosses. Phase 46 (spec D1): a review that leaves
 * stability at KNOWN_STABILITY or more dates `reachedOn`, once; the recompute replays
 * this same function, so it rebuilds the date from the answer history.
 */
export function applySession(rows: readonly MemoryRow[], answers: readonly GradedAnswer[], day: string): MemoryRow[] {
  const states = new Map<string, MemoryRow>(rows.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const touched = new Set<string>();
  for (const answer of answers) {
    for (const { dimension, grade } of gradesFor(answer)) {
      const key = keyOf(answer.glossId, dimension);
      const previous = states.get(key);
      const state = review(previous?.state ?? null, grade, day);
      const reachedOn = previous?.reachedOn ?? (state.stability >= KNOWN_STABILITY ? day : null);
      states.set(key, { glossId: answer.glossId, dimension, state, reachedOn });
      touched.add(key);
    }
  }
  return [...touched].map((key) => states.get(key)!);
}

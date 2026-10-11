import { gradesFor, review, type Dimension, type GradableAnswer, type MemoryState } from '@lang-tutor/core/domain';

/**
 * Phase 35 (spec D4, D8). The memory a session's answers leave behind. Pure: the
 * day is passed in (ADR 0001 R3). The live path (services/sessions.ts) and the
 * recompute (db/progressRecompute.ts) both run this one function.
 */

/** One row of gloss_memory: a gloss and dimension's FSRS state. */
export type MemoryRow = { glossId: string; dimension: Dimension; state: MemoryState };

/** An answer about a gloss, as `gradesFor` reads it. */
export type GradedAnswer = GradableAnswer & { glossId: string };

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}\u0000${dimension}`;

/**
 * Applies the answers in order, each piece of each answer as one review on `day`.
 * `review` takes the long-term rule for a row last reviewed on an earlier day (or
 * a first review) and t = 0 for one already reviewed on `day`, so the first
 * review of a day is long-term and every later one is not, across sessions too.
 * Returns the rows that changed, in the order each was first touched. The caller
 * passes only answers about saved glosses.
 */
export function applySession(rows: readonly MemoryRow[], answers: readonly GradedAnswer[], day: string): MemoryRow[] {
  const states = new Map<string, MemoryRow>(rows.map((row) => [keyOf(row.glossId, row.dimension), row]));
  const touched = new Set<string>();
  for (const answer of answers) {
    for (const { dimension, grade } of gradesFor(answer)) {
      const key = keyOf(answer.glossId, dimension);
      const state = review(states.get(key)?.state ?? null, grade, day);
      states.set(key, { glossId: answer.glossId, dimension, state });
      touched.add(key);
    }
  }
  return [...touched].map((key) => states.get(key)!);
}

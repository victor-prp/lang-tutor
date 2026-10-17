import { retrievability, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { TARGET_ALMOST, TARGET_READY } from './chooseConstants';

/**
 * Phase 53 (spec D1, D4). A learner's targets (a word list with a due date): when one is
 * active, and how ready a word is for the date by its FSRS memory. Phase 57 (spec D1, D9,
 * §8): the split of a session between targets is gone with paths, and FSRS readiness is
 * the recorded yardstick beside the target skills (session_targets.fsrs_ready_count), never
 * shown. Pure: the days are passed in as text and no clock is read (ADR 0001 R3).
 */

export const TARGET_KINDS = ['homework', 'exam'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Spec D4, from the least ready to the most. */
export const READINESS = ['not_started', 'on_the_way', 'almost', 'ready'] as const;
export type Readiness = (typeof READINESS)[number];

/** Phase 57 (spec D10, ruling P2). A target is active from its creation through its due
 *  date, unless ended early: its path is on home and its words leave the main path. */
export function activeOn(target: { endedAt: unknown; dueOn: string }, today: string): boolean {
  return target.endedAt === null && today <= target.dueOn;
}

/** Phase 53 (spec D1), phase 57 (spec D10). A target is open to change while it is active and
 *  its date is still to come: on the date it is refused, as before. */
export function openOn(target: { endedAt: unknown; dueOn: string }, today: string): boolean {
  return target.endedAt === null && today < target.dueOn;
}

const SPEAKING: Dimension = 'spoken_productive';

/**
 * Spec D4, ruling R-D4. The chance of remembering the gloss on dueOn in its weakest
 * skill: the minimum over the live skills (without spoken_productive when the gloss is
 * not speakable) of retrievability(state, dueOn), a skill with no row counting 0.
 * Null when the gloss has no memory row at all: not met.
 */
export function recallOnDue(
  rows: readonly { dimension: Dimension; state: MemoryState }[],
  live: readonly Dimension[],
  speakable: boolean,
  dueOn: string,
): number | null {
  if (rows.length === 0) return null;
  const states = new Map(rows.map((row) => [row.dimension, row.state] as const));
  // R never exceeds 1, so starting the minimum at 1 changes no result.
  let weakest = 1;
  for (const dimension of live) {
    if (dimension === SPEAKING && !speakable) continue;
    const state = states.get(dimension);
    weakest = Math.min(weakest, state === undefined ? 0 : retrievability(state, dueOn));
  }
  return weakest;
}

/** Spec D4: not met, or the recall read against the kind's two bars. */
export function readinessOf(kind: TargetKind, recall: number | null): Readiness {
  if (recall === null) return 'not_started';
  if (recall >= TARGET_READY[kind]) return 'ready';
  if (recall >= TARGET_ALMOST[kind]) return 'almost';
  return 'on_the_way';
}

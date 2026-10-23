import { SESSION_LENGTH } from '@lang-tutor/core/domain';
import { CARD_SECONDS } from './targetSummary';

/**
 * Phase 73 (spec D1). The daily goal for My words, in completed sessions. enrollments.my_words_goal
 * stores null for the default, 0 for off and 1–20 for a choice, so a learner who never chose
 * follows a change of the default (the phase 70 pattern). Pure.
 */
export const DEFAULT_MY_WORDS_GOAL = 3;
export const MAX_MY_WORDS_GOAL = 20;

/** The goal in force from what the enrollment stores: null is the default, 0 is off (null here). */
export function goalOf(stored: number | null): number | null {
  if (stored === null) return DEFAULT_MY_WORDS_GOAL;
  return stored === 0 ? null : stored;
}

/** The goal as stored: the default as null, off (null) as 0. */
export function storedGoal(goal: number | null): number | null {
  if (goal === null) return 0;
  return goal === DEFAULT_MY_WORDS_GOAL ? null : goal;
}

/** What a goal of that many sessions costs the learner, in minutes. */
export function goalMinutes(goal: number): number {
  return Math.round((goal * SESSION_LENGTH * CARD_SECONDS) / 60);
}

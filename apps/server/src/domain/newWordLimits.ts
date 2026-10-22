import { DAY_NEW_CAP } from './chooseConstants';

/**
 * Phase 70 (spec D1–D3). The learner's own new-word limits, as the picker reads them: the day's
 * cap on first meetings, every path's together, and the new words a regular session includes:
 * null is automatic (phase 37 D3: up to NEW_PER_SESSION, giving way to a backlog down to
 * NEW_FLOOR), a number is that many whatever the backlog, while the day has room. Pure.
 */
export type NewWordLimits = { dayCap: number; perSession: 1 | 2 | null };

/** What a learner who never chose gets, and every bot. */
export const DEFAULT_LIMITS: NewWordLimits = { dayCap: DAY_NEW_CAP, perSession: null };

/** The limits in force from what `users` stores: null is the default (spec D1). */
export function limitsOf(stored: { dayCap: number | null; perSession: number | null }): NewWordLimits {
  return {
    dayCap: stored.dayCap ?? DAY_NEW_CAP,
    perSession: stored.perSession === 1 || stored.perSession === 2 ? stored.perSession : null,
  };
}

/** Spec D1. The cap as stored: the default as null, so choosing it keeps following the default. */
export function storedDayCap(dayCap: number): number | null {
  return dayCap === DAY_NEW_CAP ? null : dayCap;
}

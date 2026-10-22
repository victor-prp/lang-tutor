import type { NewWordLimits } from '@lang-tutor/core/api';

/**
 * Phase 70 (spec D6, D7). The new-word limits screen's choices, and when a session says the
 * day's cap held its new words back. The server takes any cap from 1 to 100; the screen offers
 * these. Per session is automatic (null) or 1 or 2.
 */
export const DAY_CAP_OPTIONS: readonly number[] = [5, 10, 15, 20, 30, 50];
export const PER_SESSION_OPTIONS: readonly NewWordLimits['per_session'][] = [null, 1, 2];

/** The body a save sends: a tap changes one limit, the other as it is. */
export const withDayCap = (limits: NewWordLimits, dayCap: number): NewWordLimits => ({ ...limits, day_cap: dayCap });
export const withPerSession = (limits: NewWordLimits, perSession: NewWordLimits['per_session']): NewWordLimits => ({
  ...limits,
  per_session: perSession,
});

/** Spec D6. What a session's view says the cap held back, while it is news; null otherwise. */
export type HeldNewWords = { count: number; dayCap: number };

/** Spec D6. The message opens over the first card, before any answer, once per session. */
export function capNoticeDue({ held, position, shown }: { held: HeldNewWords | null; position: number; shown: boolean }): boolean {
  return held !== null && position === 1 && !shown;
}

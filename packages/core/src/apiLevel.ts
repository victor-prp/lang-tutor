/**
 * Phase 32 (spec D9; ADR 0012). The wire contract's compatibility level.
 *
 * An installed Android app can be older than the server it calls: Play updates
 * it on its own schedule, and an over-the-air update cannot cross a native
 * change. The native app sends API_LEVEL on every API call; the server answers
 * 426 to a lower one.
 *
 * Raise API_LEVEL by one, in the same PR, when a change breaks older clients:
 * a removed or renamed field, a new required request field, a changed meaning.
 * Most PRs never touch it.
 */
export const API_LEVEL = 1;

/** Written here and nowhere else (ADR 0012 R3). */
export const API_LEVEL_HEADER = 'X-Api-Level';

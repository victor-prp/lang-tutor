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
 *
 * 2: phase 34 (spec D9). An answer that is right but not the saved word holds
 * its card for a second try, and the response carries that card again. An
 * older app shows it as the next card and answers it without `retry`, which
 * replays, so it would be stuck on the card.
 *
 * 3: phase 39 (spec D11). Two reasons. The `new_meaning` question type: an
 * older app cannot draw it. And the `wrong_script` refusal of a typed answer
 * in the wrong alphabet: a request an older app would have had graded.
 *
 * 4: phase 54 (spec D6). The meet question type and the seen answer: an older
 * app cannot draw the card.
 *
 * 5: phase 57 (spec D13). A target's `ready_count` now counts words at 100% readiness
 * (it counted those ready by FSRS), and a target's word loses its `readiness` enum for
 * `readiness_pct`, `today`, `owed`, `starts_in` and `skills`: an older app would read
 * `undefined` where it drew a name.
 */
export const API_LEVEL = 5;

/** Written here and nowhere else (ADR 0012 R3). */
export const API_LEVEL_HEADER = 'X-Api-Level';

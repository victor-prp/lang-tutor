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
 *
 * 6: phase 65: readiness is the expected grade; ready_count counts words at 90; word skills are
 * chances. A target's `readiness_pct` and `ready_count` keep their names and change meaning, and a
 * word's skills carry `chance` and `held` in place of `value` and `cap`: an older app would draw
 * the grade as points and read `undefined` where it drew a skill's bar (spec D10).
 *
 * Not raised by phase 67b (review I3): `readiness_pct`, `readiness_start_pct`, a word's
 * `readiness_pct` and `ready_count` now count a word at its kind's bar as 100 and `practice_more_little`
 * means "no session today can raise the card". The fields keep their types and an older app still
 * draws a percent and asks before practice more less often, so none of it breaks one.
 *
 * Not raised by phase 71 (spec D8): a target's `word_readiness` is new, and on the eve `today.state`
 * is owed while a session can raise the card, its budget met or not. The field keeps its values and
 * meaning (work owed today); an older app draws its budget line on the eve, "כמעט שם", until its
 * update lands, which misleads and breaks nothing.
 *
 * 7: phase 74 (spec D11). Words for me's cards are choices: a card's answer is a pick and an add,
 * not a typed meaning, and a run loses `unknown_count` and `items` (its list) for `added_count` and
 * `added`, with the list's endpoints gone; the new-word limits' PUT requires `discover_count`. An
 * older app would type into a card the server no longer grades and wait on a list that never comes.
 */
export const API_LEVEL = 7;

/** Written here and nowhere else (ADR 0012 R3). */
export const API_LEVEL_HEADER = 'X-Api-Level';

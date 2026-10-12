/**
 * Phase 35 (spec D7). Every number the research chose for the picker, named, in
 * one place. Each "research's choice" is a starting value for the bots to tune:
 * tuning is a one-line change here.
 */

/** Anki's default; inside Eglington & Pavlik's 0.86–0.94. A word is due once its
 *  weakest live dimension's R is at or below this (ruling 11). */
export const R_TARGET = 0.9;

/** Research's choice. The chance of success a card is aimed at (D6). */
export const CARD_TARGET = 0.85;

/** Research's choice. A dimension with memory is asked at rung 2, recall, from this R
 *  up, and at rung 1, recognition, below it. Phase 37 (spec D2): memory decides,
 *  not the level; a dimension's first card is recognition. */
export const RUNG_R = 0.75;

/** Research's choice. The exponent on R for a rung-1 card's chance of success. */
export const RECOGNITION_EXPONENT = 0.5;

/** Research's choice. New words a session introduces before anything else fills it,
 *  when the due words leave room (phase 37 D3). */
export const NEW_PER_SESSION = 3;

/** Phase 37 (spec D3, D5). New words a session introduces however many words are due,
 *  while the daily cap allows: a fixed reserve outgrows a learner's sessions. */
export const NEW_FLOOR = 1;

/** Research's choice; Anki's default is 20 cards a day. New words a day. */
export const DAY_NEW_CAP = 15;

/** Research's choice. Picks testing one dimension, at most, counted against the
 *  dimension's expansions only (phase 37 D3): a newly live dimension does not flood
 *  a session, and a due word is never held back for it. */
export const PER_DIMENSION_CAP = 4;

/** Research's choice. Picks whose best card has an expected success below 0.6, at most. */
export const HARD_CAP = 4;

/** Phase 37 (spec D1). A word met or missed today comes back in later sessions until it is
 *  answered right, at most this many times a day; the memory model brings it back tomorrow. */
export const RETURNS_PER_DAY = 3;

/** Phase 37 (spec D4). Picks a session gives speaking when the device records. */
export const SPEAKING_PER_SESSION = 1;

/** Phase 39 (spec D2). Days of stability at which a skill counts as known: a skill is
 *  known once remembered right on a later day. One right answer the next day lifts
 *  the first day's 2.3 to 7.3. */
export const KNOWN_STABILITY = 7;

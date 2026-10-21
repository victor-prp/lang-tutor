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
 *  when the due words leave room (phase 37 D3). Phase 54 (spec D4): also the most ladders a
 *  session holds, across every pool and pass, the pass past the daily cap included. Phase 55
 *  (spec D4): two, where it was three. */
export const NEW_PER_SESSION = 2;

/** Phase 54 (spec D4). Slots of SESSION_LENGTH a new word's first session takes. Phase 55
 *  (spec D4): its four graded cards, the intro stage's write-it card and the three practice
 *  cards, tiles or typed alike; the meet and read-aloud cards are free. */
export const LADDER_SLOTS = 4;

/** Phase 37 (spec D3, D5). New words a session introduces however many words are due,
 *  while the daily cap allows: a fixed reserve outgrows a learner's sessions. */
export const NEW_FLOOR = 1;

/** Research's choice; Anki's default is 20 cards a day. New words a day. */
export const DAY_NEW_CAP = 15;

/** Phase 67 (spec D3, Victor: "8 words a day is already a lot"). The most new words a target's
 *  plan meets in a day before its eve; practice more can start more. */
export const NEW_TARGET_WORDS_PER_DAY = 8;

/** Phase 68 (spec D3, my call). Step-downs a target session asks at most, on top of its slots;
 *  the rest wait for the next session. */
export const STEP_DOWNS_PER_SESSION = 3;

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

/** Phase 53 (spec D4). A target word is ready for its date once its chance of being
 *  remembered on the due date, in its weakest skill, is at least this: a homework's from
 *  0.8, an exam's from 0.9. A starting value, named here to tune. Phase 57 (spec D9): the
 *  recorded yardstick's bar (session_targets.fsrs_ready_count), never shown. */
export const TARGET_READY = { homework: 0.8, exam: 0.9 } as const;

/** Phase 53 (spec D4). Below TARGET_READY, a chance from this up reads "almost ready";
 *  below it, "on the way". A starting value, named here to tune. */
export const TARGET_ALMOST = { homework: 0.6, exam: 0.7 } as const;

/** Phase 57 (spec D5, ruled in half-points). A target's cap on a skill's value by days left,
 *  in half-points (20 = 10 points). Keys are the practice days, descending: a day between
 *  entries takes the entry of the smallest table day at or above it, past the last day the
 *  value below, and the due date (days left 0 or less) takes the top. A starting value,
 *  named here to tune in the day simulation. */
export const TARGET_CAP_HALVES: readonly (readonly [daysLeft: number, cap: number])[] = [
  [27, 3],
  [20, 4],
  [14, 5],
  [9, 6],
  [5, 7],
  [4, 8],
  [3, 10],
  [2, 16],
  [1, 20],
];

/** Phase 57 (spec D5). The cap past the table's longest day, and on the due date. */
export const TARGET_CAP_FAR_HALVES = 2;
export const TARGET_CAP_DUE_HALVES = 20;

/** Phase 57 (spec D4). Half-points a session moves a target skill by: a recall card gives
 *  +4, a recognition card +2, an Again costs 4. A starting value, named here to tune. */
export const TARGET_POINTS_HALVES = { recall: 4, recognition: 2, miss: 4 } as const;


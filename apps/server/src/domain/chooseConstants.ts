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

/** Research's choice. Below this R a dimension is asked at rung 1, recognition. */
export const RUNG_R = 0.75;

/** Research's choice. The exponent on R for a rung-1 card's chance of success. */
export const RECOGNITION_EXPONENT = 0.5;

/** Research's choice. New words a session introduces before anything else fills it. */
export const NEW_PER_SESSION = 3;

/** Research's choice; Anki's default is 20 cards a day. New words a day. */
export const DAY_NEW_CAP = 15;

/** Research's choice. Picks testing one dimension, at most. */
export const PER_DIMENSION_CAP = 4;

/** Research's choice. Picks whose best card has an expected success below 0.6, at most. */
export const HARD_CAP = 4;

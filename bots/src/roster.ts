import type { ActrParams } from './actr.ts';
import { ACTR_AVERAGE } from './actr.ts';
import type { Rng } from './rng.ts';
import type { Language } from './words.ts';

/** Spec D13. Six bots; the hidden truth of how each forgets lives here and in its state, never on the server. */
export type Profile = {
  name: string;
  memory: 'actr' | 'fsrs';
  /** ACT-R parameters; absent for the FSRS control bot. */
  actr?: ActrParams;
  language: Language;
  /** Sessions a day, inclusive range. */
  sessions: readonly [number, number];
  /** Chance of playing on a given day. */
  playChance: number;
  devices: { listening: boolean; speaking: boolean };
  /** Words looked up and saved on a played day, inclusive range. */
  lookups: readonly [number, number];
  /** Chance on a played day of saving a burst of BURST_SIZE words, as a photo import does. */
  burstChance: number;
  /** Chance a recalled form is typed with one letter wrong. */
  slip: number;
  /** Chance a failed typed or spoken card is given up rather than answered with another word. */
  gaveUp: number;
};

export const BURST_SIZE = 30;

/**
 * The ACT-R variants (Ruling 23 knobs), checked with ages in seconds (Ruling 30). A word answered
 * once a day for a week at 08:00 (a trace plus the 0.5 seen-answer trace each day) recalls the
 * next morning at about 0.95 for FAST, 0.83 for ACTR_AVERAGE and 0.66 for FORGETFUL, and a word
 * met once is near 0.13 a day later on average. FORGETFUL was a: 0.22, tau: -0.5 while ages were
 * hours; in seconds that left it at 0.47 after a week of daily practice, a bot that barely learns.
 */
export const ACTR_FAST: ActrParams = { ...ACTR_AVERAGE, a: 0.12, tau: -0.8 };
export const ACTR_FORGETFUL: ActrParams = { ...ACTR_AVERAGE, a: 0.2, tau: -0.6 };

const base = {
  playChance: 1,
  devices: { listening: true, speaking: true },
  burstChance: 0.02,
} as const;

export const ROSTER: readonly Profile[] = [
  {
    ...base,
    name: 'steady-en',
    memory: 'actr',
    actr: ACTR_AVERAGE,
    language: 'en',
    sessions: [1, 2],
    lookups: [3, 5],
    slip: 0.05,
    gaveUp: 0.2,
  },
  {
    ...base,
    name: 'fast-ru',
    memory: 'actr',
    actr: ACTR_FAST,
    language: 'ru',
    sessions: [2, 3],
    lookups: [4, 6],
    slip: 0.03,
    gaveUp: 0.1,
  },
  {
    ...base,
    name: 'forgetful-it',
    memory: 'actr',
    actr: ACTR_FORGETFUL,
    language: 'it',
    sessions: [1, 1],
    lookups: [2, 4],
    slip: 0.1,
    gaveUp: 0.35,
  },
  {
    ...base,
    name: 'skipper-en',
    memory: 'actr',
    actr: ACTR_AVERAGE,
    language: 'en',
    sessions: [1, 1],
    playChance: 2 / 3,
    lookups: [2, 4],
    slip: 0.05,
    gaveUp: 0.2,
  },
  {
    ...base,
    name: 'silent-ru',
    memory: 'actr',
    actr: ACTR_AVERAGE,
    language: 'ru',
    sessions: [1, 2],
    devices: { listening: true, speaking: false },
    lookups: [3, 5],
    slip: 0.05,
    gaveUp: 0.2,
  },
  {
    ...base,
    name: 'control-it',
    memory: 'fsrs',
    language: 'it',
    sessions: [1, 2],
    lookups: [3, 5],
    slip: 0.05,
    gaveUp: 0.2,
  },
];

/** The hours of day (simulated) for a given number of sessions. */
const HOURS: Record<number, readonly number[]> = { 1: [8], 2: [8, 20], 3: [8, 14, 20] };

const between = (rng: Rng, [lo, hi]: readonly [number, number]) => lo + Math.floor(rng() * (hi - lo + 1));

export function playsToday(profile: Profile, rng: Rng): boolean {
  return rng() < profile.playChance;
}

export function sessionHours(profile: Profile, rng: Rng): number[] {
  return [...HOURS[between(rng, profile.sessions)]];
}

/** How many words to look up and save today. */
export function lookupsToday(profile: Profile, rng: Rng): number {
  const burst = rng() < profile.burstChance;
  const n = between(rng, profile.lookups);
  return burst ? BURST_SIZE : n;
}

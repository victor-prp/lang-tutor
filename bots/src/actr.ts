import { dimensionsTested, type Dimension } from '@lang-tutor/core/domain';

import type { BotMemory, LearnEvent, When } from './memory.ts';
import { mulberry32, normal, seedFrom } from './rng.ts';

/**
 * Spec D14. ACT-R declarative memory with Pavlik & Anderson's (2003, 2005) spacing-sensitive decay:
 *
 *   m   = ln sum_j w_j * age_j^(-d_j)       activation
 *   d_j = c * e^(m_(j-1)) + a               decay of trace j; m_0 = -infinity so d_1 = a
 *   P   = 1 / (1 + e^((tau - m) / s))       recall
 *
 * Time is simulated hours. Time between sessions is multiplied by h, as in the papers. A stretch
 * between two consecutive events of the item (a trace or "now") longer than SESSION_GAP_HOURS is
 * "between sessions" and counts h times; a shorter one is within a session and counts in full.
 * The age of trace j is the sum of these stretches from t_j to now.
 */
export type ActrParams = { a: number; c: number; s: number; tau: number; h: number };

export const ACTR_AVERAGE: ActrParams = { a: 0.167, c: 0.232, s: 0.252, tau: -0.669, h: 0.031 };

export const SESSION_GAP_HOURS = 1;
/** An age of zero would make a trace infinitely strong; one minute is the floor. */
export const MIN_AGE_HOURS = 1 / 60;

export type Trace = { at: number; weight: number };

export function addTrace(traces: readonly Trace[], at: number, weight = 1): Trace[] {
  const next = [...traces, { at, weight }];
  return next.sort((x, y) => x.at - y.at);
}

/** Effective age of every trace at `now`, newest trace last. */
function agesAt(traces: readonly Trace[], now: number, h: number): number[] {
  const ages = new Array<number>(traces.length);
  let age = 0;
  let next = now;
  for (let j = traces.length - 1; j >= 0; j--) {
    const gap = Math.max(0, next - traces[j].at);
    age += gap > SESSION_GAP_HOURS ? gap * h : gap;
    ages[j] = Math.max(age, MIN_AGE_HOURS);
    next = traces[j].at;
  }
  return ages;
}

/** Activation m at `now`; -Infinity with no trace. */
export function activation(traces: readonly Trace[], now: number, params: ActrParams): number {
  const decays: number[] = [];
  let m = -Infinity;
  for (let j = 0; j < traces.length; j++) {
    // m_(j-1): the activation just before trace j, from the traces before it.
    m = j === 0 ? -Infinity : activationWith(traces.slice(0, j), traces[j].at, decays, params.h);
    decays.push(params.c * Math.exp(m) + params.a);
  }
  return activationWith(traces, now, decays, params.h);
}

function activationWith(traces: readonly Trace[], now: number, decays: readonly number[], h: number): number {
  if (traces.length === 0) return -Infinity;
  const ages = agesAt(traces, now, h);
  let sum = 0;
  for (let j = 0; j < traces.length; j++) sum += traces[j].weight * Math.pow(ages[j], -decays[j]);
  return Math.log(sum);
}

/** P(recall) at `now`. `tauShift` is the word's hidden difficulty, added to tau. */
export function recall(traces: readonly Trace[], now: number, params: ActrParams, tauShift = 0): number {
  if (traces.length === 0) return 0;
  const m = activation(traces, now, params);
  return 1 / (1 + Math.exp((params.tau + tauShift - m) / params.s));
}

/** Guessing: with n options a wrong recall still hits 1/n of the time (4 options: 0.25 + 0.75 P). */
export function guess(p: number, optionCount: number): number {
  const g = 1 / optionCount;
  return g + (1 - g) * p;
}

/** Strength of the trace a card adds to a dimension, relative to a full practice trace. */
export const SEEN_ANSWER_WEIGHT = 0.5;
/** Productive practice also exercises the receptive side of the same modality. */
export const TRANSFER_RECEPTIVE = 0.3;
/** Written and spoken practice of the same kind feed each other a little. */
export const TRANSFER_CROSS = 0.1;
/** Producing the written form rehearses its spelling. */
export const TRANSFER_SPELLING = 0.2;

const TRANSFER: Partial<Record<Dimension, ReadonlyArray<readonly [Dimension, number]>>> = {
  written_productive: [
    ['written_receptive', TRANSFER_RECEPTIVE],
    ['spelling', TRANSFER_SPELLING],
    ['spoken_productive', TRANSFER_CROSS],
  ],
  spoken_productive: [
    ['spoken_receptive', TRANSFER_RECEPTIVE],
    ['written_productive', TRANSFER_CROSS],
  ],
  written_receptive: [['spoken_receptive', TRANSFER_CROSS]],
  spoken_receptive: [['written_receptive', TRANSFER_CROSS]],
};

/** Standard deviation of the hidden per-word shift of tau. */
export const DIFFICULTY_SD = 0.35;

export type ActrState = {
  /** `word|dimension` to its traces. */
  traces: Record<string, Trace[]>;
  /** `word` to its hidden tau shift, drawn once. */
  shifts: Record<string, number>;
};

export class ActrMemory implements BotMemory {
  readonly name: string;
  readonly params: ActrParams;
  readonly state: ActrState;
  private now = 0;

  constructor(opts: { name: string; params: ActrParams; state?: ActrState }) {
    this.name = opts.name;
    this.params = opts.params;
    this.state = opts.state ?? { traces: {}, shifts: {} };
  }

  setTime(when: When): void {
    this.now = when.hour;
  }

  /** The word's hidden difficulty, a shift of tau drawn once from the bot's name and the word. */
  shiftFor(word: string): number {
    const known = this.state.shifts[word];
    if (known !== undefined) return known;
    const shift = normal(mulberry32(seedFrom(`${this.name}|difficulty|${word}`))) * DIFFICULTY_SD;
    this.state.shifts[word] = shift;
    return shift;
  }

  recall(word: string, dimension: Dimension): number {
    return recall(this.state.traces[`${word}|${dimension}`] ?? [], this.now, this.params, this.shiftFor(word));
  }

  learn(word: string, event: LearnEvent): void {
    const dims = dimensionsTested(event.type);
    const add = (dimension: Dimension, weight: number) => {
      const key = `${word}|${dimension}`;
      this.state.traces[key] = addTrace(this.state.traces[key] ?? [], this.now, weight);
    };
    this.shiftFor(word);
    for (const dimension of dims) {
      add(dimension, 1);
      // The right answer is shown afterwards, right or wrong: a weaker trace.
      add(dimension, SEEN_ANSWER_WEIGHT);
    }
    const practised = new Set(dims);
    const transferred = new Map<Dimension, number>();
    for (const dimension of dims) {
      for (const [target, weight] of TRANSFER[dimension] ?? []) {
        if (!practised.has(target)) transferred.set(target, Math.max(transferred.get(target) ?? 0, weight));
      }
    }
    for (const [target, weight] of transferred) add(target, weight);
  }
}

/**
 * Phase 35 (spec D2). The FSRS-6 memory model, written for whole UTC days.
 * Pure: the day is passed in, no clock is read (ADR 0001 R3).
 */

/** 1 Again, 2 Hard, 3 Good. Easy is never used (spec D2). */
export type Grade = 1 | 2 | 3;

export type MemoryState = {
  stability: number;
  difficulty: number;
  /** UTC calendar date, `YYYY-MM-DD`. */
  lastDay: string;
  reps: number;
  lapses: number;
  /** The parameter-set id. */
  params: string;
};

/** Parameter sets, keyed by id: a later fit is a new entry here. */
export const FSRS6_DEFAULT = {
  id: 'fsrs6-default',
  w: [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
    1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
  ] as readonly number[],
} as const;

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

/** py-fsrs floors stability after every update. */
const STABILITY_MIN = 0.001;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clampD = (d: number) => clamp(d, 1, 10);

function paramsFor(id: string): readonly number[] {
  if (id === FSRS6_DEFAULT.id) return FSRS6_DEFAULT.w;
  throw new Error(`unknown memory parameter set: ${id}`);
}

/** R(t, S) = (1 + F·t/S)^(−w20), F = 0.9^(−1/w20) − 1, t in whole UTC days since lastDay. */
export function retrievability(state: MemoryState, day: string): number {
  const w = paramsFor(state.params);
  const t = Math.max(0, dayNumber(day) - dayNumber(state.lastDay));
  const decay = w[20];
  const factor = Math.pow(0.9, -1 / decay) - 1;
  return Math.pow(1 + (factor * t) / state.stability, -decay);
}

const initialDifficulty = (w: readonly number[], grade: number) => w[4] - Math.exp(w[5] * (grade - 1)) + 1;

/**
 * Applies one graded review. `state` null is the row's first review.
 *
 * Difficulty mean-reverts toward D0(Easy), the initial difficulty of an Easy first review
 * (grade 4), taken unclamped (about −4.77 with the defaults), as py-fsrs does; only the result
 * is clamped to 1–10 (ruling 12). Easy is never a grade here, but it is the reversion target.
 * Stability is floored at STABILITY_MIN after every update.
 */
export function review(state: MemoryState | null, grade: Grade, day: string): MemoryState {
  const w = paramsFor(state?.params ?? FSRS6_DEFAULT.id);
  if (state === null) {
    return {
      stability: w[grade - 1],
      difficulty: clampD(initialDifficulty(w, grade)),
      lastDay: day,
      reps: 1,
      lapses: grade === 1 ? 1 : 0,
      params: FSRS6_DEFAULT.id,
    };
  }
  const { stability: s, difficulty: d } = state;
  const t = Math.max(0, dayNumber(day) - dayNumber(state.lastDay));
  let next: number;
  if (t === 0) {
    const m = Math.exp(w[17] * (grade - 3 + w[18])) * Math.pow(s, -w[19]);
    next = s * (grade >= 2 ? Math.max(1, m) : m);
  } else {
    const r = retrievability(state, day);
    if (grade === 1) {
      const forgot = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
      next = Math.min(forgot, s / Math.exp(w[17] * w[18]));
    } else {
      const hardPenalty = grade === 2 ? w[15] : 1;
      next = s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hardPenalty);
    }
  }
  const difficulty = clampD(
    w[7] * initialDifficulty(w, 4) + (1 - w[7]) * (d - (w[6] * (grade - 3) * (10 - d)) / 9),
  );
  return {
    stability: Math.max(STABILITY_MIN, next),
    difficulty,
    lastDay: day,
    reps: state.reps + 1,
    lapses: state.lapses + (grade === 1 ? 1 : 0),
    params: state.params,
  };
}

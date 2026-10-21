/**
 * Phase 65 (spec D1–D3). A target's readiness is the expected grade on its due date, read from
 * a copy of the FSRS memory model: the first try of a day decides, one miss a day counts, a
 * same-day bonus, and an exam holds a skill that was missed. Phase 67b (spec D1–D3): a word is
 * as ready as its weakest skill, the card counts a word at its kind's bar as 100, and only the
 * eve counts answers after a skill's first of the day. Pure (ADR 0001).
 */
import {
  FSRS6_DEFAULT,
  retrievability,
  review,
  type Grade,
  type MemoryState,
} from "./memory";
import type { Dimension } from "./progress";

export type ReadinessKind = "homework" | "exam";

export type ReadinessRow = {
  state: MemoryState;
  /** The last day an answer moved this row. */
  day: string;
  missedToday: boolean;
  bonusUsed: number;
  /** Exam only: the day's first answer was a miss and no right has lifted it since. */
  held: boolean;
};

export type ReadinessWhy = "first_right" | "first_miss" | "miss" | "bonus";

/** A same-day right closes this share of the gap to 1 (spec R3). */
export const READINESS_BONUS_SHARE = 0.25;
/** Phase 67b (spec D3). `bonusUsed` counts the day's bonuses up to this many (the stored row's
 *  check holds it there); the eve's bonuses past it still apply. */
export const READINESS_BONUS_RECORDED = 2;
/** An exam counts a held skill at this share of its chance. */
export const READINESS_EXAM_HOLD = 0.5;
/** A word at or above this percent is ready: what the plan steers by, for every kind. */
export const READINESS_WORD_READY = 90;
/** Phase 67b (spec D2). A word at or above its kind's bar counts as 100 on the card. */
export const READINESS_CARD_BAR: Record<ReadinessKind, number> = {
  homework: 90,
  exam: 95,
};

const COUNTED: Record<ReadinessKind, readonly Dimension[]> = {
  homework: ["written_productive", "spelling", "spoken_productive"],
  exam: ["written_productive", "spelling"],
};

/** The skills of a word that count toward `kind` (spec D1): the counted ones it has live. */
export function countedSkills(
  kind: ReadinessKind,
  live: readonly Dimension[],
): Dimension[] {
  return COUNTED[kind].filter((d) => live.includes(d));
}

/** A row read from an existing memory state: nothing answered today yet. */
export function readinessFromMemory(state: MemoryState): ReadinessRow {
  return {
    state,
    day: state.lastDay,
    missedToday: false,
    bonusUsed: 0,
    held: false,
  };
}

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

/** Sets the stability so the state's chance on `dueOn` becomes `r + SHARE·(1 − r)`. */
function withBonus(state: MemoryState, dueOn: string): MemoryState {
  const decay = FSRS6_DEFAULT.w[20];
  const factor = Math.pow(0.9, -1 / decay) - 1;
  const t = dayNumber(dueOn) - dayNumber(state.lastDay);
  const r = retrievability(state, dueOn);
  if (t <= 0 || r >= 0.9999) return state;
  const target = r + READINESS_BONUS_SHARE * (1 - r);
  return {
    ...state,
    stability: (factor * t) / (Math.pow(target, -1 / decay) - 1),
  };
}

/** Applies one graded answer to a skill's row; null means the answer is ignored. Phase 67b
 *  (spec D3): before the eve only a skill's first answer of the day counts; on the eve a later
 *  right closes a quarter of the gap with no daily limit and wins back an exam's hold. */
export function applyReadiness(
  row: ReadinessRow | null,
  grade: Grade,
  day: string,
  dueOn: string,
  kind: ReadinessKind,
): { row: ReadinessRow; why: ReadinessWhy } | null {
  if (day >= dueOn) return null;
  if (row === null || row.day !== day) {
    const miss = grade === 1;
    return {
      row: {
        state: review(row?.state ?? null, grade, day),
        day,
        missedToday: miss,
        bonusUsed: 0,
        held: kind === "exam" && miss,
      },
      why: miss ? "first_miss" : "first_right",
    };
  }
  if (dayNumber(dueOn) - dayNumber(day) > 1) return null;
  if (grade === 1) {
    if (row.missedToday) return null;
    return {
      row: { ...row, state: review(row.state, 1, day), missedToday: true },
      why: "miss",
    };
  }
  return {
    row: {
      ...row,
      state: withBonus(row.state, dueOn),
      bonusUsed: Math.min(row.bonusUsed + 1, READINESS_BONUS_RECORDED),
      held: false,
    },
    why: "bonus",
  };
}

/** The chance (0..1) the skill is answered right on `dueOn`. Takes no today: nothing moves overnight. */
export function skillChance(row: ReadinessRow | null, dueOn: string): number {
  if (!row) return 0;
  return (
    retrievability(row.state, dueOn) * (row.held ? READINESS_EXAM_HOLD : 1)
  );
}

/** A word's chance: its weakest counted skill (phase 67b D1). */
export function wordChance(chances: readonly number[]): number {
  return chances.length === 0 ? 0 : Math.min(...chances);
}

export function readinessPct(wordChances: readonly number[]): number {
  if (wordChances.length === 0) return 0;
  return Math.floor(
    (100 * wordChances.reduce((s, c) => s + c, 0)) / wordChances.length,
  );
}

/** Phase 67b (spec D2). A word's percent as the card counts it: 100 at its kind's bar. */
export function cardWordPct(pct: number, kind: ReadinessKind): number {
  return pct >= READINESS_CARD_BAR[kind] ? 100 : pct;
}

/** Phase 67b (spec D2). The card's number: the mean of its words' card percents, rounded down. */
export function cardPct(wordPcts: readonly number[], kind: ReadinessKind): number {
  if (wordPcts.length === 0) return 0;
  return Math.floor(
    wordPcts.reduce((s, pct) => s + cardWordPct(pct, kind), 0) / wordPcts.length,
  );
}

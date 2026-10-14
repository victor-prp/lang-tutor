import { SESSION_LENGTH, retrievability, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import {
  EXAM_RUN_UP_DAYS,
  HOMEWORK_LAST_DAY_SLOTS,
  TARGET_ALMOST,
  TARGET_READY,
  TARGET_STEADY_SLOTS,
} from './chooseConstants';

/**
 * Phase 53 (spec D4-D7). The rules that split a practice session between a learner's
 * targets (a word list with a due date) and their normal practice: how ready a word is
 * for the date, how many slots a target asks for, how the slots are shared, and how
 * many new words a target owes today. Pure: the days are passed in as text and no clock
 * is read (ADR 0001 R3).
 */

export const TARGET_KINDS = ['homework', 'exam'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** Spec D4, from the least ready to the most. */
export const READINESS = ['not_started', 'on_the_way', 'almost', 'ready'] as const;
export type Readiness = (typeof READINESS)[number];

/** Spec D5, D8. Why a target asked for the slots it did. */
export type ShareReason = 'exclusive' | 'run_up' | 'not_ready' | 'steady';

const SPEAKING: Dimension = 'spoken_productive';

/**
 * Spec D4, ruling R-D4. The chance of remembering the gloss on dueOn in its weakest
 * skill: the minimum over the live skills (without spoken_productive when the gloss is
 * not speakable) of retrievability(state, dueOn), a skill with no row counting 0.
 * Null when the gloss has no memory row at all: not met.
 */
export function recallOnDue(
  rows: readonly { dimension: Dimension; state: MemoryState }[],
  live: readonly Dimension[],
  speakable: boolean,
  dueOn: string,
): number | null {
  if (rows.length === 0) return null;
  const states = new Map(rows.map((row) => [row.dimension, row.state] as const));
  // R never exceeds 1, so starting the minimum at 1 changes no result.
  let weakest = 1;
  for (const dimension of live) {
    if (dimension === SPEAKING && !speakable) continue;
    const state = states.get(dimension);
    weakest = Math.min(weakest, state === undefined ? 0 : retrievability(state, dueOn));
  }
  return weakest;
}

/** Spec D4: not met, or the recall read against the kind's two bars. */
export function readinessOf(kind: TargetKind, recall: number | null): Readiness {
  if (recall === null) return 'not_started';
  if (recall >= TARGET_READY[kind]) return 'ready';
  if (recall >= TARGET_ALMOST[kind]) return 'almost';
  return 'on_the_way';
}

/**
 * Spec D5. The slots a target asks of a session, out of SESSION_LENGTH, and why: the
 * highest row that applies. Exclusive (an exam with one day left) takes every slot from
 * everything else (D6). daysLeft is at least 1 while the target is active.
 */
export function targetWish(
  kind: TargetKind,
  daysLeft: number,
  allReady: boolean,
): { wish: number; exclusive: boolean; reason: ShareReason } {
  if (kind === 'exam') {
    if (daysLeft <= 1) return { wish: SESSION_LENGTH, exclusive: true, reason: 'exclusive' as const };
    if (daysLeft <= EXAM_RUN_UP_DAYS) return { wish: SESSION_LENGTH, exclusive: false, reason: 'run_up' as const };
  }
  if (!allReady) return { wish: SESSION_LENGTH, exclusive: false, reason: 'not_ready' as const };
  if (kind === 'homework' && daysLeft <= 1) return { wish: HOMEWORK_LAST_DAY_SLOTS, exclusive: false, reason: 'run_up' as const };
  return { wish: TARGET_STEADY_SLOTS[kind], exclusive: false, reason: 'steady' as const };
}

export type SplitInput = { targetId: string; dueOn: string; wish: number; exclusive: boolean };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The order every tie in splitSlots resolves by: the nearer dueOn, then the smaller targetId. */
const nearer = (a: SplitInput, b: SplitInput) => compare(a.dueOn, b.dueOn) || compare(a.targetId, b.targetId);

/**
 * Spec D6. Any exclusive: the exclusive ones share total evenly, the rest 0. Else wishes
 * summing to at most total are granted; else proportional by largest remainder. Every tie
 * (remainder, even share) goes to the nearer dueOn, then the smaller targetId. Every input
 * id is a key of the result. Wishes and total are whole numbers.
 */
export function splitSlots(wishes: readonly SplitInput[], total: number): Map<string, number> {
  const slots = new Map<string, number>(wishes.map((input) => [input.targetId, 0]));

  const exclusive = wishes.filter((input) => input.exclusive).sort(nearer);
  if (exclusive.length > 0) {
    const each = Math.floor(total / exclusive.length);
    const odd = total - each * exclusive.length;
    exclusive.forEach((input, i) => slots.set(input.targetId, each + (i < odd ? 1 : 0)));
    return slots;
  }

  const asked = wishes.reduce((sum, input) => sum + input.wish, 0);
  if (asked <= total) {
    for (const input of wishes) slots.set(input.targetId, input.wish);
    return slots;
  }

  // Largest remainder. A target's exact share is wish * total / asked: it gets the whole part,
  // and the slots left over go one each to the largest remainders. In integers, so two equal
  // remainders are exactly equal and the tie rule decides.
  const shares = wishes.map((input) => ({
    input,
    whole: Math.floor((input.wish * total) / asked),
    remainder: (input.wish * total) % asked,
  }));
  const odd = total - shares.reduce((sum, share) => sum + share.whole, 0);
  shares.sort((a, b) => b.remainder - a.remainder || nearer(a.input, b.input));
  shares.forEach((share, i) => slots.set(share.input.targetId, share.whole + (i < odd ? 1 : 0)));
  return slots;
}

/**
 * Spec D7, ruling R-D7. The new words a target still owes today so that all its words are
 * met before its last day: today's even share of the unmet words and those already met
 * today, over the days left before the last day (at least one), less those already met
 * today. A floor for the target's run, not a cap.
 */
export function owedNew(unmet: number, metToday: number, daysLeft: number): number {
  const days = Math.max(1, daysLeft - 1);
  return Math.max(0, Math.ceil((unmet + metToday) / days) - metToday);
}

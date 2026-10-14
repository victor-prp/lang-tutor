import { SESSION_LENGTH, type Dimension, type MemoryState } from '@lang-tutor/core/domain';

import { choosePools, liveDimensions, type ChoiceInput, type ChosenPick, type Pool } from './choose';
import { daysBetween } from './progress';
import { owedNew, readinessOf, recallOnDue, splitSlots, targetWish, type ShareReason, type TargetKind } from './targets';

/**
 * Phase 53 (spec D5–D7, rulings R-D6, R-D7). A session split between the learner's
 * targets and the main path: each target's readiness for its date gives its wish, the
 * wishes share the session's slots, and one pick runs over the pools, the targets
 * nearest date first and the main path last. Pure: the day is the choice's (ADR 0001 R3).
 */

/** A target active on the choice's day. */
export type ActiveTarget = { id: string; kind: TargetKind; dueOn: string; glossIds: readonly string[] };

export type TargetSessionInput = {
  /** saved: every saved gloss, as today. */
  choice: ChoiceInput;
  /** The targets active on choice.today; their glosses are saved. */
  targets: readonly ActiveTarget[];
  /** Ruling R-D4. Per saved gloss, whether it can be said; a gloss left out can. */
  speakable: ReadonlyMap<string, boolean>;
  /** Spec D7. The glosses first met on choice.today. */
  introducedToday: ReadonlySet<string>;
};

/** Spec D8. What one session gave one target. `picked` counts its pool's picks over both
 *  passes, so it passes `slots` when the main path leaves slots unpicked; a gloss in two
 *  targets counts for the one served first. */
export type TargetSplit = {
  targetId: string;
  wish: number;
  slots: number;
  picked: number;
  reason: ShareReason;
  daysLeft: number;
  readyCount: number;
  wordCount: number;
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Each target's split (picked 0) and pool, in the order the pools run: the nearer
 *  dueOn first, then the smaller id, as splitSlots breaks its ties. */
function plan(input: TargetSessionInput): { split: TargetSplit; pool: Pool }[] {
  const { choice } = input;
  const live = liveDimensions(choice.listening, choice.speaking);
  const rows = new Map<string, { dimension: Dimension; state: MemoryState }[]>();
  for (const row of choice.memory) {
    const glossRows = rows.get(row.glossId);
    if (glossRows) glossRows.push(row);
    else rows.set(row.glossId, [row]);
  }

  const targets = [...input.targets].sort((a, b) => compare(a.dueOn, b.dueOn) || compare(a.id, b.id));
  const wishes = targets.map((target) => {
    const daysLeft = daysBetween(choice.today, target.dueOn);
    const readiness = (glossId: string) =>
      readinessOf(target.kind, recallOnDue(rows.get(glossId) ?? [], live, input.speakable.get(glossId) ?? true, target.dueOn));
    const readyCount = target.glossIds.filter((glossId) => readiness(glossId) === 'ready').length;
    const wordCount = target.glossIds.length;
    return { target, daysLeft, readyCount, wordCount, ...targetWish(target.kind, daysLeft, readyCount === wordCount) };
  });
  const slots = splitSlots(
    wishes.map(({ target, wish, exclusive }) => ({ targetId: target.id, dueOn: target.dueOn, wish, exclusive })),
    SESSION_LENGTH,
  );

  return wishes.map(({ target, daysLeft, readyCount, wordCount, wish, reason }) => {
    const share = slots.get(target.id) ?? 0;
    const unmet = target.glossIds.filter((glossId) => !rows.has(glossId)).length;
    const metToday = target.glossIds.filter((glossId) => input.introducedToday.has(glossId)).length;
    return {
      split: { targetId: target.id, wish, slots: share, picked: 0, reason, daysLeft, readyCount, wordCount },
      pool: { glossIds: new Set(target.glossIds), slots: share, owedNew: owedNew(unmet, metToday, daysLeft) },
    };
  });
}

/** The split alone (no picking): what D12's stale check compares. */
export function targetSplit(input: TargetSessionInput): TargetSplit[] {
  return plan(input).map(({ split }) => split);
}

/**
 * One session: the targets' pools, then the main path with the slots they left, in one
 * call of the picker; slots the main path cannot use go back to the targets in a second
 * pass. The picks come in pool order; the split in the same order, each target's `picked`
 * filled in. With no target, exactly chooseWords(choice).
 */
export function chooseWithTargets(input: TargetSessionInput): { picks: ChosenPick[]; split: TargetSplit[] } {
  const planned = plan(input);
  const targetSlots = planned.reduce((sum, { pool }) => sum + pool.slots, 0);
  const main: Pool = { glossIds: null, slots: SESSION_LENGTH - targetSlots, owedNew: 0 };
  const chosen = choosePools(input.choice, [...planned.map(({ pool }) => pool), main]);
  return {
    picks: chosen.flat(),
    split: planned.map(({ split }, index) => ({ ...split, picked: chosen[index].length })),
  };
}

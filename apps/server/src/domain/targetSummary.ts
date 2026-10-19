import {
  READINESS_LITTLE,
  READINESS_WORD_READY,
  countedSkills,
  readinessFromMemory,
  readinessGainBound,
  readinessPct,
  skillChance,
  wordChance,
  type Dimension,
  type MemoryState,
  type ReadinessKind,
  type ReadinessRow,
} from '@lang-tutor/core/domain';

import type { TargetDay } from './targetDay';

/**
 * Phase 65 (spec D1, D3.7, D4, D7, D9, D10). The numbers a target's summary carries: its
 * readiness (the grade its words would get on the date), readiness at the start of today, its
 * ready words, whether one more session could add only a little; and today as a budget of
 * sessions. Pure (ADR 0001): the rows, the day and the counts are passed in.
 */

/** Spec D7.1 (my call). About how long a card takes, for the minutes beside the offer. */
export const CARD_SECONDS = 30;

export type SkillReadiness = { dimension: Dimension; chance: number; held: boolean };
export type WordReadiness = { glossId: string; readinessPct: number; skills: SkillReadiness[] };

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}\u0000${dimension}`;
const percent = (chance: number) => Math.floor(100 * chance);

/**
 * Spec D1, D4, D9, R1. Per word, its counted skills among its live ones (readTargetDay's: speaking
 * dropped for a word that cannot be said or a device that does not record), each read from its
 * stored row, else from the word's main memory (R1), else as no state (chance 0). Readiness is
 * the mean of the words' chances; at the start of today each skill reads the `before` of its
 * first line today instead, where it has one. Spec D3.7: the rows freeze on the date by
 * themselves (the rule ignores answers from it on), but the main memory does not, and a review
 * on or after the date reads as certain; so from the date on, a memory last moved on or after it
 * is not read (its eve's value is gone): the skill reads as no state. Spec D9, D7.8: more practice
 * adds little only when the plan owes nothing today (else the next session asks owed work, which
 * can add more) and even every right answer still countable today would add under
 * READINESS_LITTLE points (readinessGainBound, an upper bound).
 */
export function readinessSummary(input: {
  kind: ReadinessKind;
  dueOn: string;
  today: string;
  /** The plan's state today (targetDay's). */
  plan: TargetDay['state'];
  /** The target's words, each with its live skills. */
  words: readonly { glossId: string; live: readonly Dimension[] }[];
  /** The target's readiness rows. */
  rows: readonly { glossId: string; dimension: Dimension; row: ReadinessRow }[];
  /** The words' main memory. */
  memory: readonly { glossId: string; dimension: Dimension; state: MemoryState }[];
  /** What each skill read before its first line today. */
  firstToday: readonly { glossId: string; dimension: Dimension; before: number }[];
}): { readinessPct: number; readinessStartPct: number; readyCount: number; practiceMoreLittle: boolean; words: WordReadiness[] } {
  const { kind, dueOn, today } = input;
  const stored = new Map(input.rows.map((entry) => [keyOf(entry.glossId, entry.dimension), entry.row]));
  const memory = new Map(input.memory.map((entry) => [keyOf(entry.glossId, entry.dimension), entry.state]));
  const firstToday = new Map(input.firstToday.map((entry) => [keyOf(entry.glossId, entry.dimension), entry.before]));
  const rowOf = (glossId: string, dimension: Dimension): ReadinessRow | null => {
    const key = keyOf(glossId, dimension);
    const own = stored.get(key);
    if (own) return own;
    const state = memory.get(key);
    return state && state.lastDay < dueOn ? readinessFromMemory(state) : null;
  };

  const counted = input.words.map((word) => {
    const skills = countedSkills(kind, word.live).map((dimension) => {
      const row = rowOf(word.glossId, dimension);
      const chance = skillChance(row, dueOn);
      return { dimension, row, chance, start: firstToday.get(keyOf(word.glossId, dimension)) ?? chance };
    });
    return { glossId: word.glossId, skills, chance: wordChance(skills.map((skill) => skill.chance)) };
  });

  return {
    readinessPct: readinessPct(counted.map((word) => word.chance)),
    readinessStartPct: readinessPct(counted.map((word) => wordChance(word.skills.map((skill) => skill.start)))),
    readyCount: counted.filter((word) => percent(word.chance) >= READINESS_WORD_READY).length,
    practiceMoreLittle:
      input.plan !== 'owed' &&
      readinessGainBound(
        counted.map((word) => word.skills.map((skill) => skill.row)),
        today,
        dueOn,
        kind,
      ) < READINESS_LITTLE,
    words: counted.map((word) => ({
      glossId: word.glossId,
      readinessPct: percent(word.chance),
      skills: word.skills.map((skill) => ({ dimension: skill.dimension, chance: percent(skill.chance), held: skill.row?.held ?? false })),
    })),
  };
}

/**
 * Spec D7. Today as a budget of sessions: the budget stored for today, else none yet (null), with
 * the offer (the budget as it would be set now) shown in its place; the path's sessions completed
 * today; and about how long the budget's cards take. The state: due_today from the date on; else
 * done once the budget is met (only a budget that was set: a session started by its first answer
 * sets none); else the plan's (owed, done when no word owes work, rest). Done before the budget
 * was met is ended early (spec D7.6).
 */
export function todaySummary(input: {
  /** The plan's state (targetDay's). */
  plan: TargetDay['state'];
  daysLeft: number;
  /** The budget stored for today. */
  budget: { sessions: number; cards: number } | null;
  /** The budget as it would be set now, when none is stored. */
  offer: { sessions: number; cards: number } | null;
  sessionsDone: number;
}): { state: TargetDay['state']; sessionsBudget: number | null; sessionsOffer: number; sessionsDone: number; endedEarly: boolean; minutes: number } {
  const { budget, sessionsDone } = input;
  const shown = budget ?? input.offer;
  let state: TargetDay['state'];
  if (input.daysLeft <= 0) state = 'due_today';
  else if (budget !== null && sessionsDone >= budget.sessions) state = 'done';
  else state = input.plan;
  return {
    state,
    sessionsBudget: budget?.sessions ?? null,
    sessionsOffer: shown?.sessions ?? 0,
    sessionsDone,
    endedEarly: state === 'done' && (budget === null || sessionsDone < budget.sessions),
    minutes: Math.round(((shown?.cards ?? 0) * CARD_SECONDS) / 60),
  };
}

import {
  READINESS_CARD_BAR,
  cardPct,
  cardWordPct,
  countedSkills,
  readinessFromMemory,
  skillChance,
  wordChance,
  type Dimension,
  type MemoryState,
  type ReadinessKind,
  type ReadinessRow,
} from '@lang-tutor/core/domain';

import type { SkillStart, TargetDay } from './targetDay';

/**
 * Phase 65 (spec D1, D3.7, D4, D7, D9, D10). The numbers a target's summary carries: its
 * readiness (the grade its words would get on the date), readiness at the start of today, its
 * ready words, whether one more session could add only a little; and today as a budget of
 * sessions. Pure (ADR 0001): the rows, the day and the counts are passed in.
 */

/** Spec D7.1 (my call). About how long a card takes, for the minutes beside the offer. */
export const CARD_SECONDS = 30;

export type SkillReadiness = { dimension: Dimension; chance: number; held: boolean };
/** `readinessPct` is the word as the card counts it (100 at its kind's bar, phase 67b D2);
 *  `weakestOpenToday`, whether no answer has moved its weakest counted skill today: before the eve
 *  only a skill's first answer counts and only the weakest moves the word (phase 67b D1, D6). */
export type WordReadiness = { glossId: string; readinessPct: number; weakestOpenToday: boolean; skills: SkillReadiness[] };

const keyOf = (glossId: string, dimension: Dimension) => `${glossId}\u0000${dimension}`;
const percent = (chance: number) => Math.floor(100 * chance);

type SkillReads = {
  dueOn: string;
  rows: readonly { glossId: string; dimension: Dimension; row: ReadinessRow }[];
  memory: readonly { glossId: string; dimension: Dimension; state: MemoryState }[];
  firstToday: readonly { glossId: string; dimension: Dimension; before: number }[];
};

/** Spec R1, D3.7. A skill's row: its own, else one read from the main memory last moved before
 *  the date, else none; and each skill's `before` of its first line today. */
function readersOf(input: SkillReads) {
  const stored = new Map(input.rows.map((entry) => [keyOf(entry.glossId, entry.dimension), entry.row]));
  const memory = new Map(input.memory.map((entry) => [keyOf(entry.glossId, entry.dimension), entry.state]));
  const firstToday = new Map(input.firstToday.map((entry) => [keyOf(entry.glossId, entry.dimension), entry.before]));
  const rowOf = (glossId: string, dimension: Dimension): ReadinessRow | null => {
    const key = keyOf(glossId, dimension);
    const own = stored.get(key);
    if (own) return own;
    const state = memory.get(key);
    return state && state.lastDay < input.dueOn ? readinessFromMemory(state) : null;
  };
  return { rowOf, firstToday: { get: (glossId: string, dimension: Dimension) => firstToday.get(keyOf(glossId, dimension)) } };
}

/**
 * Phase 67 (spec D1). Each word's writing, spelling and speaking among its live ones, at the start
 * of today, what its day is planned from (the skills it practises, and its kind's counted ones): the chance its skill's first line today started from, else its chance now (its row, else
 * the main memory, else 0, as readinessSummary reads it), and the day its readiness last moved.
 */
export function skillStarts(input: SkillReads & { kind: ReadinessKind; words: readonly { glossId: string; live: readonly Dimension[] }[] }): SkillStart[] {
  const { rowOf, firstToday } = readersOf(input);
  return input.words.flatMap((word) =>
    countedSkills('homework', word.live).map((dimension) => {
      const row = rowOf(word.glossId, dimension);
      return {
        glossId: word.glossId,
        dimension,
        chance: firstToday.get(word.glossId, dimension) ?? skillChance(row, input.dueOn),
        movedOn: row?.day ?? null,
      };
    }),
  );
}

/**
 * Spec D1, D4, D9, R1. Per word, its counted skills among its live ones (readTargetDay's: speaking
 * dropped for a word that cannot be said or a device that does not record), each read from its
 * stored row, else from the word's main memory (R1), else as no state (chance 0). Readiness is
 * the mean of the words' chances; at the start of today each skill reads the `before` of its
 * first line today instead, where it has one. Spec D3.7: the rows freeze on the date by
 * themselves (the rule ignores answers from it on), but the main memory does not, and a review
 * on or after the date reads as certain; so from the date on, a memory last moved on or after it
 * is not read (its eve's value is gone): the skill reads as no state.
 */
export function readinessSummary(input: {
  kind: ReadinessKind;
  dueOn: string;
  today: string;
  /** The target's words, each with its live skills. */
  words: readonly { glossId: string; live: readonly Dimension[] }[];
  /** The target's readiness rows. */
  rows: readonly { glossId: string; dimension: Dimension; row: ReadinessRow }[];
  /** The words' main memory. */
  memory: readonly { glossId: string; dimension: Dimension; state: MemoryState }[];
  /** What each skill read before its first line today. */
  firstToday: readonly { glossId: string; dimension: Dimension; before: number }[];
}): { readinessPct: number; readinessStartPct: number; readyCount: number; words: WordReadiness[] } {
  const { kind, dueOn, today } = input;
  const { rowOf, firstToday } = readersOf(input);

  const counted = input.words.map((word) => {
    const skills = countedSkills(kind, word.live).map((dimension) => {
      const row = rowOf(word.glossId, dimension);
      const chance = skillChance(row, dueOn);
      return { dimension, row, chance, start: firstToday.get(word.glossId, dimension) ?? chance };
    });
    return { glossId: word.glossId, skills, chance: wordChance(skills.map((skill) => skill.chance)) };
  });
  const pcts = counted.map((word) => percent(word.chance));

  return {
    readinessPct: cardPct(pcts, kind),
    readinessStartPct: cardPct(
      counted.map((word) => percent(wordChance(word.skills.map((skill) => skill.start)))),
      kind,
    ),
    readyCount: pcts.filter((pct) => pct >= READINESS_CARD_BAR[kind]).length,
    words: counted.map((word, i) => ({
      glossId: word.glossId,
      readinessPct: cardWordPct(pcts[i], kind),
      weakestOpenToday: weakestOpen(word.skills, today),
      skills: word.skills.map((skill) => ({ dimension: skill.dimension, chance: percent(skill.chance), held: skill.row?.held ?? false })),
    })),
  };
}

/** Phase 67b (spec D1, D6, review C1). Whether a word's weakest counted skills, every one at its
 *  lowest chance, have had no answer today: a word is as ready as its weakest, so before the eve
 *  only their first answers can raise it. */
function weakestOpen(skills: readonly { chance: number; row: ReadinessRow | null }[], today: string): boolean {
  if (skills.length === 0) return false;
  const lowest = Math.min(...skills.map((skill) => skill.chance));
  return skills.filter((skill) => skill.chance === lowest).every((skill) => skill.row?.day !== today);
}

/**
 * Phase 67b (spec D6). Whether one more session today can raise the card: some word below its
 * bar (card value under 100) that practice more can still move. An unmet word, while the day has
 * room for new words (practice more meets it); a met one, on the eve (every right counts), or
 * before it while its weakest skill has had no answer today (only the first counts, and only the
 * weakest moves the word). Never on or after the date. The wire says the opposite,
 * practice_more_little: the app asks first only when it is true.
 */
export function canRaiseToday(input: {
  daysLeft: number;
  newRoom: number;
  words: readonly { readinessPct: number; met: boolean; weakestOpenToday: boolean }[];
}): boolean {
  const { daysLeft, newRoom } = input;
  if (daysLeft < 1) return false;
  return input.words.some(
    (word) => word.readinessPct < 100 && (word.met ? daysLeft === 1 || word.weakestOpenToday : newRoom > 0),
  );
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

/** Phase 67b (spec D5). What the target picker reads as readiness now (TargetPickInput.now): each
 *  word's card value, its counted skills, the lowest chance first, and whether its weakest is
 *  still open today. */
export function pickNow(words: readonly WordReadiness[]): Map<string, { pct: number; counted: Dimension[]; weakestOpen: boolean }> {
  return new Map(
    words.map((word) => [
      word.glossId,
      {
        pct: word.readinessPct,
        counted: [...word.skills].sort((a, b) => a.chance - b.chance).map((skill) => skill.dimension),
        weakestOpen: word.weakestOpenToday,
      },
    ]),
  );
}

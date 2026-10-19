import { dimensionsTested, gradesFor, type GradableAnswer, type QuestionType } from '@lang-tutor/core/domain';

import { LADDER_SLOTS } from './chooseConstants';
import { LADDER_PRACTICE } from './plan';
import { targetDay, type TargetWordInput } from './targetDay';
import { cardOf, chooseTargetPicks, type TargetPickInput } from './targetPicker';
import { applyTargetSession, type TargetAnswer, type TargetSkillRow } from './targetSkills';

/**
 * Phase 65 (spec D7.1, D7.4). Today's budget, in sessions: the sessions the target picker itself
 * would make of today's owed work if every answer were right, played forward with the picker
 * unchanged, stretched by the drift the learner's recent miss rate puts on each skill's climb, in
 * whole sessions (ruling T5-b). Set once, at the path's first session of the learner day, and
 * never raised. Pure (ADR 0001): the day and the answers are passed in.
 */

/** Spec D7.2. A target's budget for one learner day, as recorded (target_budgets): the sessions
 *  promised in all, the cards the play made, the sessions of them that are room for misses, and
 *  the path's sessions already completed that day when it was set (`doneBefore`: one started the
 *  day before and ended on it), which the promise counts as the day's. */
export type TargetBudget = { targetId: string; day: string; sessions: number; cards: number; missRoom: number; doneBefore: number };

/** Spec D7.1 (my call). A learner with fewer graded answers than MISS_RATE_MIN_ANSWERS on their
 *  last MISS_RATE_DAYS practice days is read at this miss rate. */
export const DEFAULT_MISS_RATE = 0.1;
export const MISS_RATE_MIN_ANSWERS = 20;
export const MISS_RATE_DAYS = 3;
/** Ruling T5-b. The highest miss rate the budget stretches for: the play's sessions at most
 *  doubled, so a promise stays one the learner can keep. */
export const MISS_RATE_CAP = 0.25;

/** The most sessions a play makes. Every session of the play answers owed work right, so the play
 *  always ends by itself; this bounds a very large day, which it cuts short at this count (37 or
 *  more fresh words due tomorrow, two ladders a session and each climbing to the eve's cap, reach
 *  it). Past it, the count no longer means a day anyone plays. */
export const PLAY_SESSIONS_MAX = 30;

/** The target id the play's skill rows carry: one target, so any id. */
const PLAYED = 'play';

/** A right answer to a card of `type`, as gradesFor reads one: a choice chosen right, a text card
 *  exact, a spoken one understood. */
const rightAnswer = (glossId: string, type: QuestionType): TargetAnswer => ({
  glossId,
  type,
  correct: true,
  verdict: type === 'say_translation' ? 'understood' : 'exact',
  helped: false,
});

const keyOf = (row: Pick<TargetSkillRow, 'glossId' | 'dimension'>) => `${row.glossId}|${row.dimension}`;

/**
 * Spec D7.1. Today's sessions and cards (slots: LADDER_SLOTS a ladder, one any other pick) from
 * the day as it stands, with no session in flight: while the day owes work, the picker's next
 * session of it, every pick answered right. Any pick starts its word if it was not. A ladder is
 * its practice cards (LADDER_PRACTICE, ruling T9-a), each answered right; its intro stage grades
 * nothing (phase 55). Any other pick is one right answer of its card (cardOf). The session's
 * answers move the skills through applyTargetSession against today's cap, one change per skill a
 * session, and are right today in the skills they test. The input is targetDay's, with the
 * picker's own (`pick`).
 */
export function playTodayForward(input: {
  pick: Omit<TargetPickInput, 'day' | 'mode' | 'inFlight'>;
  today: string;
  createdOn: string;
  dueOn: string;
  words: readonly TargetWordInput[];
  skills: readonly TargetSkillRow[];
  rightToday: ReadonlySet<string>;
  answeredToday: boolean;
}): { sessions: number; cards: number } {
  const { today } = input;
  let words = [...input.words];
  const skills = new Map(input.skills.map((row) => [keyOf(row), { ...row, targetId: PLAYED }]));
  const rightToday = new Set(input.rightToday);
  const glossIds = new Set(words.map((word) => word.glossId));
  let answeredToday = input.answeredToday;
  let sessions = 0;
  let cards = 0;

  while (sessions < PLAY_SESSIONS_MAX) {
    const day = targetDay({ today, createdOn: input.createdOn, dueOn: input.dueOn, words, skills: [...skills.values()], rightToday, answeredToday });
    if (day.state !== 'owed') break;
    const picks = chooseTargetPicks({ ...input.pick, day, mode: 'owed', inFlight: [] });
    if (picks.length === 0) break;
    sessions += 1;
    cards += picks.reduce((sum, pick) => sum + (pick.ladder ? LADDER_SLOTS : 1), 0);

    const asked = new Set(picks.map((pick) => pick.glossId));
    words = words.map((word) => (word.startedOn === null && asked.has(word.glossId) ? { ...word, startedOn: today } : word));
    const answers = picks.flatMap((pick) =>
      pick.ladder ? LADDER_PRACTICE.map((type) => rightAnswer(pick.glossId, type)) : [rightAnswer(pick.glossId, cardOf(pick.dimension, pick.rung))],
    );
    const moved = applyTargetSession({
      targetId: PLAYED,
      sessionId: `${PLAYED} ${sessions}`,
      day: today,
      capHalves: day.capHalves,
      glossIds,
      before: [...skills.values()],
      answers,
    });
    for (const row of moved.rows) skills.set(keyOf(row), row);
    for (const answer of answers) for (const dimension of dimensionsTested(answer.type)) rightToday.add(`${answer.glossId}|${dimension}`);
    answeredToday = true;
  }
  return { sessions, cards };
}

/**
 * Spec D7.1 (whole sessions, never fewer than the play), ruling T5-b. The budget: the all-right
 * play's sessions stretched for the learner's misses. With a miss share `m` of answers, a skill a
 * session asks moves +4 or, on a miss, −4 (spec D4), so it climbs 1 − 2m as fast as when every
 * answer is right: the play takes 1 / (1 − 2m) times as many sessions. The rate is capped at
 * MISS_RATE_CAP, so the factor is 2 at most: past it the drift would promise a count no one keeps,
 * and a day not done carries over (spec D7.5). A whole number of sessions is read as itself, not
 * one more: floating point can put it a hair above (and never below the play: no −0 for none).
 */
export function budgetSessions(play: { sessions: number; cards: number }, missRate: number): number {
  return Math.max(play.sessions, Math.ceil(play.sessions / (1 - 2 * Math.min(missRate, MISS_RATE_CAP)) - 1e-9));
}

/**
 * Spec D7.1. The learner's miss rate over `answers` (their graded answers on their last
 * MISS_RATE_DAYS practice days): the share with an Again piece. An answer that grades nothing (an
 * intro card's) counts in neither part. Fewer than MISS_RATE_MIN_ANSWERS graded: DEFAULT_MISS_RATE.
 */
export function missRateOf(answers: readonly GradableAnswer[]): number {
  const graded = answers.map(gradesFor).filter((pieces) => pieces.length > 0);
  if (graded.length < MISS_RATE_MIN_ANSWERS) return DEFAULT_MISS_RATE;
  return graded.filter((pieces) => pieces.some((piece) => piece.grade === 1)).length / graded.length;
}

/**
 * Phase 65b (spec D2). Whether a target path's day is past its budget: the budget is set and its
 * completed sessions, with the session in flight, meet it. The stock chosen beside the session
 * that meets the budget is then a full session (the picker's past_budget mode).
 */
export function pastBudget(input: { budget: number | null; done: number; inFlight: boolean }): boolean {
  return input.budget !== null && input.done + (input.inFlight ? 1 : 0) >= input.budget;
}

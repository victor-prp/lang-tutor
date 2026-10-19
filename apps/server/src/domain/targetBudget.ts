import { SESSION_LENGTH, dimensionsTested, gradesFor, type GradableAnswer, type QuestionType } from '@lang-tutor/core/domain';

import { LADDER_SLOTS } from './chooseConstants';
import { targetDay, type TargetWordInput } from './targetDay';
import { cardOf, chooseTargetPicks, type TargetPickInput } from './targetPicker';
import { applyTargetSession, type TargetAnswer, type TargetSkillRow } from './targetSkills';

/**
 * Phase 65 (spec D7.1, D7.4). Today's budget, in sessions: the sessions the target picker itself
 * would make of today's owed work if every answer were right, played forward with the picker
 * unchanged, and whole sessions of room for misses at the learner's recent miss rate. Set once,
 * at the path's first session of the learner day, and never raised. Pure (ADR 0001): the day and
 * the answers are passed in.
 */

/** Spec D7.2. A target's budget for one learner day, as recorded (target_budgets): the sessions
 *  promised, the cards the play made, and the sessions of them that are room for misses. */
export type TargetBudget = { targetId: string; day: string; sessions: number; cards: number; missRoom: number };

/** Spec D7.1 (my call). A learner with fewer graded answers than MISS_RATE_MIN_ANSWERS on their
 *  last MISS_RATE_DAYS practice days is read at this miss rate. */
export const DEFAULT_MISS_RATE = 0.1;
export const MISS_RATE_MIN_ANSWERS = 20;
export const MISS_RATE_DAYS = 3;

/** The most sessions a play makes: a guard, as a day the picker cannot finish never ends. */
const PLAY_SESSIONS_MAX = 30;

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
 * session of it, every pick answered right. A ladder starts its word and grades nothing (its intro
 * stage); any other pick is one right answer of its card (cardOf), which starts its word if it
 * was not, moves its skills through applyTargetSession against today's cap, one change per skill
 * a session, and is right today in the skills it tests. The input is targetDay's, with the
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
    const answers = picks.filter((pick) => !pick.ladder).map((pick) => rightAnswer(pick.glossId, cardOf(pick.dimension, pick.rung)));
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
 * Spec D7.1 (whole sessions, never fewer than the play). The budget: the play's sessions and the
 * room for its cards' misses at `missRate`, in whole sessions of SESSION_LENGTH. A whole number of
 * sessions is read as itself, not one more: floating point can put it a hair above.
 */
export function budgetSessions(play: { sessions: number; cards: number }, missRate: number): number {
  const room = (play.cards * missRate) / SESSION_LENGTH;
  return play.sessions + Math.max(0, Math.ceil(room - 1e-9));
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

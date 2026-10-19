import { gradesFor, type GradableAnswer, type QuestionType } from '@lang-tutor/core/domain';

import { LADDER_SLOTS } from './chooseConstants';
import { targetDay, type TargetWordInput } from './targetDay';
import { cardOf, chooseTargetPicks, type TargetPickInput } from './targetPicker';
import { applyTargetSession, type TargetAnswer, type TargetSkillRow } from './targetSkills';

/**
 * Phase 65 (spec D7.1, D7.4). Today's budget, in sessions: the sessions the target picker itself
 * would make of today's owed work, played forward with the picker unchanged, at the learner's
 * recent miss rate (ruling T5-a: the misses are played, so the picker re-asks what they cost, not
 * added as cards of room). Set once, at the path's first session of the learner day, and never
 * raised. Pure (ADR 0001): the day and the answers are passed in.
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

/** The most sessions a play makes: the loop always ends at it. It cuts a very large day short; and
 *  with misses it ends a play that would not finish, one whose missed picks keep undoing a skill's
 *  gains: at a high rate the rhythm can land on the same skill session after session (every second
 *  pick missed, above 0.4, on a day of one skill; every third, above about 0.29, on five new words
 *  due tomorrow). Played all right, every session moves owed work toward done, so the play ends by
 *  itself. */
export const PLAY_SESSIONS_MAX = 30;

/** The target id the play's skill rows carry: one target, so any id. */
const PLAYED = 'play';

/** An answer to a card of `type`, as gradesFor reads one: right, a choice chosen right, a text card
 *  exact, a spoken one understood; else a choice chosen wrong, a text card wrong, a spoken one
 *  given up. */
const answerOf = (glossId: string, type: QuestionType, right: boolean): TargetAnswer => ({
  glossId,
  type,
  correct: right,
  verdict: type === 'say_translation' ? (right ? 'understood' : 'gave_up') : right ? 'exact' : 'wrong',
  helped: false,
});

/** Ruling T5-a. At `missRate`, the play misses every this-many-th graded pick: never at 0, every
 *  second at most. */
export const missEveryOf = (missRate: number): number => (missRate > 0 ? Math.max(2, Math.round(1 / missRate)) : Number.POSITIVE_INFINITY);

const keyOf = (row: Pick<TargetSkillRow, 'glossId' | 'dimension'>) => `${row.glossId}|${row.dimension}`;

/** What a play reads: targetDay's input, with the picker's own (`pick`). */
export type PlayInput = {
  pick: Omit<TargetPickInput, 'day' | 'mode' | 'inFlight'>;
  today: string;
  createdOn: string;
  dueOn: string;
  words: readonly TargetWordInput[];
  skills: readonly TargetSkillRow[];
  rightToday: ReadonlySet<string>;
  answeredToday: boolean;
};

/**
 * Spec D7.1, ruling T5-a. Today's sessions and cards (slots: LADDER_SLOTS a ladder, one any other
 * pick) from the day as it stands, with no session in flight: while the day owes work, the
 * picker's next session of it. A ladder starts its word and grades nothing (its intro stage); any
 * other pick is one answer of its card (cardOf), which starts its word if it was not and moves its
 * skills through applyTargetSession against today's cap, one change per skill a session. At
 * `missRate` the learner misses on a fixed rhythm: every missEveryOf(missRate)-th graded pick
 * (`TARGET`) of the play, counted across its sessions, is a wrong answer, an Again that costs its
 * skill as the picker's own rule does, so a later session asks it again; a family's new meaning,
 * started like a ladder (`NEW`), is never missed. Every answer is right today in the skills it
 * grades above Again. At 0 every answer is right.
 */
export function playTodayForward(input: PlayInput & { missRate: number }): { sessions: number; cards: number } {
  const { today } = input;
  let words = [...input.words];
  const skills = new Map(input.skills.map((row) => [keyOf(row), { ...row, targetId: PLAYED }]));
  const rightToday = new Set(input.rightToday);
  const glossIds = new Set(words.map((word) => word.glossId));
  const missEvery = missEveryOf(input.missRate);
  let answeredToday = input.answeredToday;
  let sessions = 0;
  let cards = 0;
  let graded = 0;

  while (sessions < PLAY_SESSIONS_MAX) {
    const day = targetDay({ today, createdOn: input.createdOn, dueOn: input.dueOn, words, skills: [...skills.values()], rightToday, answeredToday });
    if (day.state !== 'owed') break;
    const picks = chooseTargetPicks({ ...input.pick, day, mode: 'owed', inFlight: [] });
    if (picks.length === 0) break;
    sessions += 1;
    cards += picks.reduce((sum, pick) => sum + (pick.ladder ? LADDER_SLOTS : 1), 0);

    const asked = new Set(picks.map((pick) => pick.glossId));
    words = words.map((word) => (word.startedOn === null && asked.has(word.glossId) ? { ...word, startedOn: today } : word));
    const answers = picks
      .filter((pick) => !pick.ladder)
      .map((pick) => answerOf(pick.glossId, cardOf(pick.dimension, pick.rung), pick.cls !== 'TARGET' || ++graded % missEvery !== 0));
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
    for (const answer of answers) {
      for (const piece of gradesFor(answer)) if (piece.grade > 1) rightToday.add(`${answer.glossId}|${piece.dimension}`);
    }
    answeredToday = true;
  }
  return { sessions, cards };
}

/**
 * Spec D7.1 (whole sessions, never fewer than the play), ruling T5-a. The budget: the sessions of
 * the play at the learner's `missRate`, never fewer than the play with every answer right; its
 * cards; and its room for misses, the sessions the misses add to the play all right.
 */
export function playBudget(input: PlayInput, missRate: number): { sessions: number; cards: number; missRoom: number } {
  const right = playTodayForward({ ...input, missRate: 0 });
  const missing = missRate > 0 ? playTodayForward({ ...input, missRate }) : right;
  const sessions = Math.max(missing.sessions, right.sessions);
  return { sessions, cards: missing.cards, missRoom: sessions - right.sessions };
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

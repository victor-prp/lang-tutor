import { LADDER_SLOTS } from './chooseConstants';
import { LADDER_PRACTICE } from './plan';
import { targetDay, type TargetDayInput } from './targetDay';
import { cardOf, chooseTargetPicks, type TargetPickInput } from './targetPicker';

/**
 * Phase 65 (spec D7.1, D7.4), phase 67 (spec D5). Today's budget, in sessions: the sessions the
 * target picker itself makes of today's cards, played forward. A miss adds no card, so the play is
 * the day and nothing is stretched for misses. Set once, at the path's first session of the
 * learner day, and never raised. Pure (ADR 0001): the day is passed in.
 */

/** Spec D7.2. A target's budget for one learner day, as recorded (target_budgets): the sessions
 *  promised in all, the cards the play made, the sessions of them that were room for misses (0 since phase 67), and
 *  the path's sessions already completed that day when it was set (`doneBefore`: one started the
 *  day before and ended on it), which the promise counts as the day's. */
export type TargetBudget = { targetId: string; day: string; sessions: number; cards: number; missRoom: number; doneBefore: number };

/** The most sessions a play makes. Every session of the play asks owed cards, so the play always
 *  ends by itself; this bounds a very large day (sixty or more new words due tomorrow, two
 *  ladders a session), which it cuts short at this count. Past it, the count no longer means a
 *  day anyone plays. */
export const PLAY_SESSIONS_MAX = 30;

/**
 * Phase 65 (spec D7.1), phase 67 (spec D5). Today's sessions and cards (slots: LADDER_SLOTS a
 * ladder, one any other pick) from the day as it stands, with no session in flight: while the
 * day owes work, the picker's next session of it, every pick answered. Any pick meets its word if
 * it was not; its cards are asked today (a ladder its practice cards, ruling T9-a; a new meaning
 * its new_meaning card; any other pick its card, cardOf). A miss adds no card (spec D2), so the
 * play is the day. The input is targetDay's, with the picker's own (`pick`).
 */
export function playTodayForward(input: { pick: Omit<TargetPickInput, 'day' | 'mode' | 'inFlight'> } & TargetDayInput): { sessions: number; cards: number } {
  const { today } = input;
  let words = [...input.words];
  const askedToday = [...input.askedToday];
  let answeredToday = input.answeredToday;
  let sessions = 0;
  let cards = 0;

  while (sessions < PLAY_SESSIONS_MAX) {
    const day = targetDay({ ...input, words, askedToday, answeredToday });
    if (day.state !== 'owed') break;
    const picks = chooseTargetPicks({ ...input.pick, day, mode: 'owed', inFlight: [] });
    if (picks.length === 0) break;
    sessions += 1;
    cards += picks.reduce((sum, pick) => sum + (pick.ladder ? LADDER_SLOTS : 1), 0);

    const asked = new Set(picks.map((pick) => pick.glossId));
    words = words.map((word) => (word.startedOn === null && asked.has(word.glossId) ? { ...word, startedOn: today } : word));
    for (const pick of picks) {
      if (pick.ladder) for (const type of LADDER_PRACTICE) askedToday.push({ glossId: pick.glossId, type });
      else askedToday.push({ glossId: pick.glossId, type: pick.cls === 'NEW' ? 'new_meaning' : cardOf(pick.dimension, pick.rung) });
    }
    answeredToday = true;
  }
  return { sessions, cards };
}

/**
 * Phase 65b (spec D2). Whether a target path's day is past its budget: the budget is set and its
 * completed sessions, with the session in flight, meet it. The stock chosen beside the session
 * that meets the budget is then a full session (the picker's past_budget mode).
 */
export function pastBudget(input: { budget: number | null; done: number; inFlight: boolean }): boolean {
  return input.budget !== null && input.done + (input.inFlight ? 1 : 0) >= input.budget;
}

/**
 * Phase 71 (spec D2). Whether a target path's next session is a full one, the owed work first and
 * then practice more (the picker's past_budget mode): always on the eve, which has no daily goal,
 * and before it once the day's budget is met (pastBudget).
 */
export function fullSession(input: { daysLeft: number; budget: number | null; done: number; inFlight: boolean }): boolean {
  return input.daysLeft === 1 || pastBudget(input);
}

/**
 * Phase 52 (spec D2, D3, D5, D6). The rules of a practice reminder, pure
 * (ADR 0001 R3): which slots of a learner's schedule are due at an instant,
 * whether a due slot sends or is skipped, and which sent reminder a finished
 * session counts for. The tick and the session's completion call these; the
 * instant is passed in, never taken from the system.
 */

import { dayInTimeZone, isoWeekday, localMinutes } from './learnerClock';

/** A learner's schedule. `days` are ISO weekdays (1 = Monday … 7 = Sunday),
 *  `times` are `'HH:MM'` on the learner's clock. */
export type ReminderSettings = { enabled: boolean; dailyTarget: number; days: number[]; times: string[] };

/** What a learner with no `reminder_settings` row gets: on, one session a day,
 *  every day, four slots across the day. */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  dailyTarget: 1,
  days: [1, 2, 3, 4, 5, 6, 7],
  times: ['13:00', '17:00', '20:00', '22:00'],
};

/** How long after its start a slot is still due, so one missed tick is caught up by the next. */
export const CATCH_UP_MINUTES = 30;

export const REMINDER_CHANNEL = 'reminders';
export const REMINDER_TITLE = 'Time to practise';
export const REMINDER_BODY = 'A few minutes now keeps your words fresh.';

/** One slot of one learner's day: the pair the `reminders` row is unique on. */
export type DueSlot = { localDay: string; slot: string };

/** `'HH:MM'` as minutes since midnight. */
function minutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function distinctSorted<T extends string | number>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The schedule with `days` and `times` sorted and distinct: the form it is stored in. */
export function normalizeSettings(s: ReminderSettings): ReminderSettings {
  return { ...s, days: distinctSorted(s.days), times: distinctSorted(s.times) };
}

/**
 * The slots of today, on the learner's clock, that started within the last
 * `CATCH_UP_MINUTES`, in ascending time order. Empty when reminders are off
 * or today's weekday is not one the learner chose.
 */
export function dueSlots(settings: ReminderSettings, timeZone: string, now: number): DueSlot[] {
  if (!settings.enabled || !settings.days.includes(isoWeekday(now, timeZone))) return [];
  const nowMinutes = localMinutes(now, timeZone);
  const localDay = dayInTimeZone(now, timeZone);
  return distinctSorted(settings.times)
    .filter((slot) => {
      const sinceStart = nowMinutes - minutes(slot);
      return sinceStart >= 0 && sinceStart < CATCH_UP_MINUTES;
    })
    .map((slot) => ({ localDay, slot }));
}

export type Decision = {
  kind: 'send' | 'skip_target_met';
  evidence: { completed_today: number; daily_target: number; time_zone: string; devices: number };
};

/** A target already met today skips the reminder; anything short of it sends. */
export function decide(input: { completedToday: number; dailyTarget: number; timeZone: string; devices: number }): Decision {
  return {
    kind: input.completedToday >= input.dailyTarget ? 'skip_target_met' : 'send',
    evidence: {
      completed_today: input.completedToday,
      daily_target: input.dailyTarget,
      time_zone: input.timeZone,
      devices: input.devices,
    },
  };
}

/** A sent reminder of the learner's day, with the session it was already marked for, if any. */
export type MarkCandidate = { id: string; decidedAt: number; sessionId: string | null };

/**
 * The reminder a session finished at `now` counts for: the latest one decided
 * by then, and only if no session has claimed it. A second session in the same
 * gap finds the latest marked and counts for nothing, never an earlier reminder.
 */
export function reminderForSession(candidates: MarkCandidate[], now: number): string | null {
  let latest: MarkCandidate | null = null;
  for (const c of candidates) {
    if (c.decidedAt <= now && (latest === null || c.decidedAt > latest.decidedAt)) latest = c;
  }
  return latest !== null && latest.sessionId === null ? latest.id : null;
}

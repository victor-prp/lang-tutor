/**
 * Phase 52 (spec D2, D8). The pure parts of the Reminders screen: the chips it
 * offers, what a tap on one does to the lists, the daily target's range, and the
 * saver that keeps a quick run of changes in order.
 */

/** The daily target is offered from 1 to 5, though the wire accepts up to 10 (spec D2). */
export const MIN_TARGET = 1;
export const MAX_TARGET = 5;

/** The day chips in order, Sunday first like the Israeli week; the values are ISO weekdays (1 = Monday ... 7 = Sunday). */
export const WEEK_DAYS: readonly number[] = [7, 1, 2, 3, 4, 5, 6];

/** The most times a schedule may hold: the wire takes at most eight (spec D2). */
export const MAX_TIMES = 8;

/** The hours offered: 06:00 to 23:00, whole hours (spec: minute-level times are out). */
export const HOURS: readonly number[] = Array.from({ length: 18 }, (_, index) => index + 6);

/** `06`, the hour as the chips' test ids write it. */
export const hourId = (hour: number): string => String(hour).padStart(2, '0');

/** `06:00`, the hour as the wire writes it. */
export const timeOf = (hour: number): string => `${hourId(hour)}:00`;

const distinctSorted = <T extends number | string>(values: readonly T[]): T[] =>
  [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The day added if it is missing, taken away if it is there. An empty list is a valid schedule. */
export function toggleDay(days: readonly number[], day: number): number[] {
  const on = days.includes(day);
  return distinctSorted(on ? days.filter((d) => d !== day) : [...days, day]);
}

/**
 * The hour added if it is missing, taken away if it is there, except the last
 * time left (the server wants at least one) and a ninth (it takes at most
 * eight): then the list is returned as it is. A time the screen has no chip for
 * (the wire allows minutes) is kept as it is and counts towards the eight.
 * 'HH:MM' strings sort as clock times.
 */
export function toggleHour(times: readonly string[], hour: number): string[] {
  const time = timeOf(hour);
  const current = distinctSorted(times);
  if (!current.includes(time)) return current.length >= MAX_TIMES ? current : distinctSorted([...current, time]);
  if (current.length <= 1) return current;
  return current.filter((t) => t !== time);
}

type Schedule = { enabled: boolean; daily_target: number; days: readonly number[]; times: readonly string[] };

const sameList = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Whether two settings hold the same schedule: a tap that changes nothing needs no save. */
export const sameSettings = (a: Schedule, b: Schedule): boolean =>
  a.enabled === b.enabled &&
  a.daily_target === b.daily_target &&
  sameList(a.days, b.days) &&
  sameList(a.times, b.times);

export const clampTarget = (target: number): number =>
  Math.min(MAX_TARGET, Math.max(MIN_TARGET, Math.round(target)));

export const stepTarget = (target: number, step: 1 | -1): number => clampTarget(target + step);

/**
 * Saves each change as it is made, one request at a time. A change made while
 * one is on the wire waits, and only the newest is sent after it: each change is
 * the whole settings (PUT replaces them), so the newest already carries the
 * ones before it, and two requests in flight could land out of order.
 * `onSaved` hears the answer to the last request only, and `onFailed` a failure
 * with nothing newer waiting.
 */
export function createSaver<T, R = T>(
  put: (value: T) => Promise<R>,
  on: { onSaved: (saved: R) => void; onFailed: (error: unknown) => void },
) {
  let waiting: { value: T } | null = null;
  let running = false;

  async function drain(): Promise<void> {
    running = true;
    try {
      while (waiting) {
        const { value } = waiting;
        waiting = null;
        try {
          const saved = await put(value);
          if (!waiting) on.onSaved(saved);
        } catch (error) {
          if (!waiting) on.onFailed(error);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    save(value: T): void {
      waiting = { value };
      if (!running) void drain();
    },
  };
}

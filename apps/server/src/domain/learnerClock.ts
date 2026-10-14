/**
 * Phase 52 (spec D1, ADR 0013). The learner's clock: one instant read on the
 * wall clock of an IANA time zone. Pure (ADR 0001 R3) — the instant is passed
 * in, never taken from the system — and the one formula behind a progress day
 * (`services/learnerDay.ts`) and behind the reminder tick, so the day a
 * session counts for and the hour a reminder fires never disagree.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type ClockParts = { year: string; month: string; day: string; hour: number; minute: number; weekday: number };

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
}

/** Throws a RangeError for a name that is not a time zone. */
function partsOf(now: number, timeZone: string): ClockParts {
  const byType = new Map(formatter(timeZone).formatToParts(now).map((p) => [p.type, p.value]));
  return {
    year: byType.get('year')!,
    month: byType.get('month')!,
    day: byType.get('day')!,
    hour: Number(byType.get('hour')),
    minute: Number(byType.get('minute')),
    weekday: WEEKDAYS.indexOf(byType.get('weekday')!) + 1,
  };
}

/** Whether `name` is a time zone this runtime knows: what a stored or reported zone is checked with. */
export function isTimeZone(name: string): boolean {
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

/** The date `now` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function dayInTimeZone(now: number, timeZone: string): string {
  const { year, month, day } = partsOf(now, timeZone);
  return `${year}-${month}-${day}`;
}

/** Minutes since local midnight in `timeZone`, 0..1439. */
export function localMinutes(now: number, timeZone: string): number {
  const { hour, minute } = partsOf(now, timeZone);
  return hour * 60 + minute;
}

/** The ISO weekday in `timeZone`: 1 = Monday … 7 = Sunday. */
export function isoWeekday(now: number, timeZone: string): number {
  return partsOf(now, timeZone).weekday;
}

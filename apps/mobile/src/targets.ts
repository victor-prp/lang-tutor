import type { TargetKind, TargetList, TargetReadiness } from '@lang-tutor/core/api';

import { strings } from '@/strings';

/** Phase 53 (spec D10, D11). What home and the target screen say about a target,
 *  and the days the date step offers, kept out of the screens so they are tested
 *  without rendering. */

/** The kind of a target as a title: שיעורי בית or בוחן. */
export function targetTitle(kind: TargetKind): string {
  return strings.targetKindName(kind);
}

/** A word's readiness for the date, in the four words of spec D4. */
export function readinessName(readiness: TargetReadiness): string {
  return strings.targetReadinessName(readiness);
}

/** How soon a target is: tomorrow from one day left, "in N days" after. An active
 *  target has at least one, but one read by id can be past its date, and counting
 *  down from that would show "in -2 days". */
export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft < 1) return strings.targetDateCame;
  return daysLeft === 1 ? strings.targetTomorrow : strings.targetInDays(daysLeft);
}

/** "3 of 8 ready", the motivator on home's rows and the target's screen (spec D11). */
export function readyLabel(ready: number, total: number): string {
  return strings.targetReadyCount(ready, total);
}

const DAY_MS = 86_400_000;
const DAY_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** The `count` days after `today`, the first of them tomorrow, as the date step lists
 *  them (spec D10: no native date module).
 *
 *  `today` is the learner's day as the server read it (`TargetList.today`, ADR 0013),
 *  never the phone's date, which can be another day or another zone: the days are
 *  worked out from that string alone, in UTC where no clock change moves a day. */
export function dueDateChoices(today: string, count = 60): { day: string; label: string }[] {
  const parts = DAY_FORMAT.exec(today);
  if (!parts) throw new RangeError(`not a day: ${today}`);
  // setUTCFullYear, not Date.UTC, which would read the years 0-99 as 1900-1999.
  const start = new Date(0);
  start.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(start.getTime() + (offset + 1) * DAY_MS);
    const month = date.getUTCMonth() + 1;
    return {
      day: `${pad(date.getUTCFullYear(), 4)}-${pad(month, 2)}-${pad(date.getUTCDate(), 2)}`,
      label: strings.targetDueDay(date.getUTCDay(), date.getUTCDate(), month),
    };
  });
}

/** A read of the active targets, tagged with the enrollment it was about. */
export type StoredTargets = { enrollmentId: string; list: TargetList };

/** What to show for the active enrollment. A list read for any other enrollment (a
 *  slow answer that landed after a switch) is never shown. Keyed rather than cleared
 *  on a switch, as useNextSession's and usePhotoImports' reads are: a clearing effect
 *  in the provider would run after home's own focus effect (children first) and
 *  discard the read that effect started. */
export function targetsFor(stored: StoredTargets | null, activeId: string | undefined): TargetList | null {
  return stored !== null && stored.enrollmentId === activeId ? stored.list : null;
}

import type { Target, TargetKind, TargetList, TargetSummary } from '@lang-tutor/core/api';

import { ApiError } from '@/api/client';
import { strings } from '@/strings';
import type { WizardMode, WizardStep } from '@/targetWizard';

/** Phase 53 (spec D10, D11). What home and the target screen say about a target,
 *  and the days the date step offers, kept out of the screens so they are tested
 *  without rendering. */

/** The kind of a target as a title: שיעורי בית or בוחן. */
export function targetTitle(kind: TargetKind): string {
  return strings.targetKindName(kind);
}

/** A word's readiness, in percent (phase 57, spec D9). */
export function readinessName(readinessPct: number): string {
  return strings.targetReadinessName(readinessPct);
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

/** A `YYYY-MM-DD` day as a moment, midnight UTC, where no clock change moves a day. */
function dayStart(day: string): Date {
  const parts = DAY_FORMAT.exec(day);
  if (!parts) throw new RangeError(`not a day: ${day}`);
  // setUTCFullYear, not Date.UTC, which would read the years 0-99 as 1900-1999.
  const start = new Date(0);
  start.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return start;
}

const labelOf = (date: Date): string =>
  strings.targetDueDay(date.getUTCDay(), date.getUTCDate(), date.getUTCMonth() + 1);

/** The `count` days after `today`, the first of them tomorrow, as the date step lists
 *  them (spec D10: no native date module).
 *
 *  `today` is the learner's day as the server read it (`TargetList.today`, ADR 0013),
 *  never the phone's date, which can be another day or another zone: the days are
 *  worked out from that string alone, in UTC where no clock change moves a day. */
export function dueDateChoices(today: string, count = 60): { day: string; label: string }[] {
  const start = dayStart(today);
  return Array.from({ length: count }, (_, offset) => {
    const date = new Date(start.getTime() + (offset + 1) * DAY_MS);
    const month = date.getUTCMonth() + 1;
    return {
      day: `${pad(date.getUTCFullYear(), 4)}-${pad(month, 2)}-${pad(date.getUTCDate(), 2)}`,
      label: labelOf(date),
    };
  });
}

/** A target's date as the date step words it: "יום שישי, 16 באוקטובר". From the
 *  string alone, as dueDateChoices works. */
export function dueDayLabel(day: string): string {
  return labelOf(dayStart(day));
}

const WIZARD_TITLES: Record<WizardMode, string> = {
  create: strings.targetWizardCreate,
  'add-photos': strings.targetWizardAddPhotos,
  'add-words': strings.targetWizardAddWords,
  'change-date': strings.targetWizardChangeDate,
};
const STEP_TITLES: Record<WizardStep, string> = {
  kind: strings.targetStepKind,
  photos: strings.targetStepPhotos,
  review: strings.targetStepReview,
  words: strings.targetStepWords,
  date: strings.targetStepDate,
};

/** The wizard's title: a new target, or which of a target's actions it is. */
export function wizardTitle(mode: WizardMode): string {
  return WIZARD_TITLES[mode];
}

/** What the step on screen asks. */
export function stepTitle(step: WizardStep): string {
  return STEP_TITLES[step];
}

/** The photos step's hint. A new target may skip its photos; a target screen's add photos is
 *  there for them, and its Next needs one (canAdvance), so it says nothing of skipping. */
export function photosHint(mode: WizardMode): string {
  return mode === 'add-photos' ? strings.targetPhotosHintAdd : strings.targetPhotosHint;
}

/** Whether a target's date has come, which closes it: the server refuses every change
 *  to it then. A target ended early cannot be told from the wire (it has no end date
 *  there); a change to one is refused with `target closed`, which the screens say. */
export function dateHasCome(target: Pick<TargetSummary, 'days_left'>): boolean {
  return target.days_left < 1;
}

const isClosed = (error: unknown) => error instanceof ApiError && error.code === 'target closed';

/** What the wizard says when Done is refused. The server says why it refused an
 *  invalid target (ruling R-D10's `no_words`, a `due_date` not after today), and the
 *  learner can fix both; anything else is a failure to try again. */
export function doneFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.reason === 'no_words') return strings.targetNoWords;
  if (error instanceof ApiError && error.reason === 'due_date') return strings.targetDueDatePast;
  if (isClosed(error)) return strings.targetClosed;
  return strings.targetSaveFailed;
}

/** What the target screen says when removing a word or ending is refused. */
export function actionFailureMessage(error: unknown): string {
  return isClosed(error) ? strings.targetClosed : strings.targetActionFailed;
}

/** The target as it is once a word is taken out, before the server's copy is read
 *  again: the word gone, and counted out of the words and, when it was ready, out of
 *  the ready ones. A target without the word is answered as it is. */
export function withoutWord(target: Target, glossId: string): Target {
  const word = target.words.find((candidate) => candidate.gloss_id === glossId);
  if (!word) return target;
  return {
    ...target,
    word_count: target.word_count - 1,
    ready_count: target.ready_count - (word.readiness_pct === 100 ? 1 : 0),
    words: target.words.filter((candidate) => candidate !== word),
  };
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

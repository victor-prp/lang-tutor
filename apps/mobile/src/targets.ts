import type { Target, TargetKind, TargetList, TargetSummary, TargetWord } from '@lang-tutor/core/api';
import { READINESS_CARD_BAR, READINESS_WORD_READY } from '@lang-tutor/core/domain';

import { ApiError } from '@/api/client';
import { strings, type Countdown } from '@/strings';
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
  photo: strings.targetWizardAddPhotos,
  'add-words': strings.targetWizardAddWords,
  'change-date': strings.targetWizardChangeDate,
};
const STEP_TITLES: Record<WizardStep, string> = {
  photos: strings.targetStepPhotos,
  review: strings.targetStepReview,
  choose: strings.targetStepChoose,
  words: strings.targetStepWords,
  date: strings.targetStepDate,
};

/** The wizard's title: the photo flow, or which of a target's actions it is. */
export function wizardTitle(mode: WizardMode): string {
  return WIZARD_TITLES[mode];
}

/** What the step on screen asks. */
export function stepTitle(step: WizardStep): string {
  return STEP_TITLES[step];
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
    ready_count: target.ready_count - (word.readiness_pct >= READINESS_CARD_BAR[target.kind] ? 1 : 0),
    words: target.words.filter((candidate) => candidate !== word),
  };
}

/** Phase 57 (spec D11). A card on home: the main path ("My words") or a target, by its id. */
export type HomeCard = 'main' | string;

/** Phase 65. A target is ready when every word is at its bar: ready_count counts them (phase 67b D2). */
const allReady = (target: Pick<TargetSummary, 'word_count' | 'ready_count'>): boolean =>
  target.ready_count === target.word_count;

const byDate = (a: TargetSummary, b: TargetSummary) =>
  a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Phase 57 (spec D10, D11). Home's cards by priority: a target on its date, then the
 *  targets with work owed today, nearest date first, then My words, then the targets done
 *  for today or resting, by date (a tie on the date by id, so the order never flickers).
 *
 *  `first` is the card whose button is filled, and the path a reminder opens: the first in
 *  that order, past a target on its date already at 100%, whose last review is outlined
 *  (D10), and past a target with no word, which has no button (final review M3). My words is
 *  always a candidate, so there is always one. */
export function homeOrder(targets: readonly TargetSummary[]): { first: HomeCard; order: HomeCard[] } {
  const sorted = [...targets].sort(byDate);
  const ids = (states: TargetSummary['today']['state'][]) =>
    sorted.filter((target) => states.includes(target.today.state)).map((target) => target.id);
  const order = [...ids(['due_today']), ...ids(['owed']), 'main', ...ids(['done', 'rest'])];
  const outlined = new Set(
    sorted
      .filter((target) => (target.today.state === 'due_today' && allReady(target)) || target.word_count === 0)
      .map((target) => target.id),
  );
  const first = order.find((card) => !outlined.has(card)) ?? 'main';
  return { first, order };
}

/** Phase 64 (spec D4). The countdown as the card's header draws it: the days left large with
 *  "ימים" beside it, then "מחר", then "היום" on the date itself. */
export function countdownBig(daysLeft: number): { big: string; unit: string | null } {
  if (daysLeft < 1) return { big: strings.countdownToday, unit: null };
  if (daysLeft === 1) return { big: strings.countdownTomorrow, unit: null };
  return { big: strings.countdownNumber(daysLeft), unit: strings.countdownDays };
}

/** The days from one `YYYY-MM-DD` to another, from the strings alone, in UTC. */
const daysBetweenDays = (from: string, to: string): number =>
  Math.round((dayStart(to).getTime() - dayStart(from).getTime()) / DAY_MS);

/** Whether a target is in its last two days (R9): tomorrow, or the date itself. */
export function isUrgent(target: Pick<TargetSummary, 'days_left'>): boolean {
  return target.days_left <= 1;
}

/** Phase 64 (spec D5). The fuse at the bottom of the header: the share of the target's time
 *  still left, from the day it was made to its date, between 0 and 1. In the last two days it
 *  is hot (amber, glowing) and labelled. */
export type Fuse = { share: number; hot: boolean; label: string | null };

export function fuseOf(target: Pick<TargetSummary, 'created_on' | 'due_on' | 'days_left'>): Fuse {
  const whole = Math.max(1, daysBetweenDays(target.created_on, target.due_on));
  const share = Math.max(0, Math.min(1, target.days_left / whole));
  if (!isUrgent(target)) return { share, hot: false, label: null };
  return { share, hot: true, label: target.days_left < 1 ? strings.fuseToday : strings.fuseOneDay };
}

/** Phase 64 (spec D5). The line under the header in the last two days: the words not ready
 *  yet, or that every word is. None before, and none for a target with no word. */
export type Urgency = { kind: 'not-ready' | 'ready'; text: string } | null;

export function urgencyOf(target: Pick<TargetSummary, 'kind' | 'days_left' | 'word_count' | 'ready_count'>): Urgency {
  if (!isUrgent(target) || target.word_count === 0) return null;
  const missing = target.word_count - target.ready_count;
  if (missing <= 0) return { kind: 'ready', text: strings.targetAllReady(target.kind) };
  // Phase 71 (spec D5): on the eve the count is the card's words row.
  if (isEve(target)) return { kind: 'not-ready', text: strings.targetEveStrip(target.kind) };
  return { kind: 'not-ready', text: strings.targetNotReady(target.kind, target.days_left, missing) };
}

/** Phase 71 (spec D4). The eve, one day left, with a word: no daily goal, its row counts the words. */
const isEve = (target: Pick<TargetSummary, 'days_left' | 'word_count'>): boolean => target.days_left === 1 && target.word_count > 0;

/** Phase 64 (spec D4). A target's button is solid when pressing it is the thing to do now:
 *  work owed today, or the last review on the date until every word is ready (phase 57 D10,
 *  phase 65: ready is a word at READINESS_WORD_READY). */
export function targetButtonSolid(target: TargetSummary): boolean {
  if (target.today.state === 'owed') return true;
  return target.today.state === 'due_today' && !allReady(target);
}

/** Phase 64 (spec D3, D5). How a dot of the stack is drawn: the top card's long and blue, a
 *  card in its last two days that is not on top amber, any other grey. */
export function dotLook({ onTop, urgent }: { onTop: boolean; urgent: boolean }): 'on' | 'urgent' | 'off' {
  if (onTop) return 'on';
  return urgent ? 'urgent' : 'off';
}

/** Phase 64b (spec D4). One bar under the cards: its card, whether it is in its last two days,
 *  what it shows (a name, or from five cards the kind's icon and the due day's letter) and what a
 *  screen reader says of it (the card's full name and its place). */
export type StackBar = {
  card: HomeCard;
  urgent: boolean;
  label: string;
  icon: 'main' | 'exam' | 'homework' | null;
  spoken: string;
};

/** From this many cards the bars show the kind's icon and the day instead of names. */
const COMPACT_BARS = 5;

/** Phase 64b (spec D4). The bars, one per card in home's order; none for one card. A target is
 *  named by its kind, with its due day's letter when another target shares the kind or the bars
 *  are compact; My words by its name (its icon alone when compact). */
export function stackBars(order: readonly HomeCard[], targets: readonly TargetSummary[]): StackBar[] {
  if (order.length <= 1) return [];
  const compact = order.length >= COMPACT_BARS;
  const byId = new Map(targets.map((target) => [target.id, target]));
  const kinds = order.flatMap((card) => {
    const target = byId.get(card);
    return target ? [target.kind] : [];
  });
  return order.map((card, at) => {
    const target = byId.get(card);
    const place = (name: string) => strings.barSpoken(name, at + 1, order.length);
    if (!target) {
      return { card, urgent: false, label: compact ? '' : strings.myWords, icon: compact ? 'main' : null, spoken: place(strings.myWords) };
    }
    const day = strings.dayLetter(dayStart(target.due_on).getUTCDay());
    const kind = strings.targetKindName(target.kind);
    const shared = kinds.filter((other) => other === target.kind).length > 1;
    const name = shared || compact ? `${kind} ${day}` : kind;
    return { card, urgent: isUrgent(target), label: compact ? day : name, icon: compact ? target.kind : null, spoken: place(name) };
  });
}

/** Phase 57 (spec D10, D11). What a target's card shows: its title (the countdown, or the
 *  date itself), the line under it, its readiness and its button's label. Readiness shows in
 *  every state; the card draws it with its bar. Phase 65: today is its sessions (sessionsLine). */
export type TargetCardState = {
  title: Countdown;
  /** The rest day's line, or good luck on the date. */
  note: { kind: 'rest' | 'due-today'; text: string } | null;
  readiness: string;
  /** Null for a target with no word (final review M3): its path has nothing to ask. */
  button: string | null;
};

export function targetCardState(target: TargetSummary): TargetCardState {
  const card = cardOfDay(target);
  return target.word_count === 0 ? { ...card, button: null } : card;
}

function cardOfDay(target: TargetSummary): TargetCardState & { button: string } {
  const { kind, today } = target;
  const title = strings.targetCountdown(kind, target.days_left);
  const readiness = strings.targetReadinessPct(kind, target.readiness_pct);
  switch (today.state) {
    case 'owed':
      return { title, note: null, readiness, button: strings.practiceNow };
    case 'done':
      return { title, note: null, readiness, button: strings.practiceMore };
    case 'rest':
      return {
        title,
        note: { kind: 'rest', text: strings.targetRest(kind, today.next_practice_in) },
        readiness,
        button: strings.practiceMore,
      };
    case 'due_today':
      return {
        title: strings.targetCountdown(kind, 0),
        note: { kind: 'due-today', text: strings.targetGoodLuck },
        readiness,
        button: strings.lastReview,
      };
  }
}

/** Phase 57 (spec D9). Readiness's colour: red at 0%, through orange and yellow, to green
 *  at 100%, by hue alone. */
export function readinessColor(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  return `hsl(${Math.round(clamped * 1.2)}, 65%, 42%)`;
}

/** Phase 57. Home reads the targets again while any target's session is being prepared,
 *  as it does the main path's (nextSession's shouldPoll). */
export function shouldPollTargets(list: TargetList | null): boolean {
  return list?.targets.some((target) => target.session?.status === 'preparing') ?? false;
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

/** Phase 57 (spec D12). The target screen's groups, in the order they show. */
export type WordGroup = { today: TargetWord['today']; words: TargetWord[] };

const GROUP_ORDER: TargetWord['today'][] = ['owed', 'done', 'extra', 'later'];

/** The words by what today holds for them, an empty group left out, each keeping the
 *  order the server sent. */
export function wordGroups(words: readonly TargetWord[]): WordGroup[] {
  return GROUP_ORDER.map((today) => ({ today, words: words.filter((word) => word.today === today) })).filter(
    (group) => group.words.length > 0,
  );
}

export function groupTitle(today: TargetWord['today']): string {
  return strings.targetGroupTitle[today];
}

/** Final review M1. The target screen's word list: before the date, the day's groups (spec
 *  D12), each titled and each row with its line for today; on the date, when nothing is owed
 *  (D10), and after it, the words alone, with no title and no line. */
export type ScreenGroup = { key: TargetWord['today'] | 'all'; title: string | null; lines: boolean; words: TargetWord[] };

export function screenGroups(target: Pick<Target, 'days_left' | 'words'>): ScreenGroup[] {
  if (target.words.length === 0) return [];
  if (dateHasCome(target)) return [{ key: 'all', title: null, lines: false, words: [...target.words] }];
  return wordGroups(target.words).map((group) => ({ key: group.today, title: groupTitle(group.today), lines: true, words: group.words }));
}

/** A word's line for today under its row: what it still owes, that it is done, a bonus,
 *  or when it starts. Null when there is nothing to say (a later word with no start). */
export function wordTodayLine(word: TargetWord): string | null {
  switch (word.today) {
    case 'owed':
      return strings.targetWordOwed(word.owed.map((dimension) => strings.dimensionName(dimension)));
    case 'done':
      return strings.targetWordDone;
    case 'extra':
      return strings.targetWordExtra;
    case 'later':
      return word.starts_in === null ? null : strings.targetWordStartsIn(word.starts_in);
  }
}

/** Phase 65 (spec D4, D5). The readiness bar: the start of the day pale, the day's gain bright
 *  at its end (negative on a lower day), and the gain's label, none before any answer today. */
export function readinessBar(target: Pick<TargetSummary, 'readiness_pct' | 'readiness_start_pct'>): {
  start: number;
  gain: number;
  label: string | null;
} {
  const start = target.readiness_start_pct;
  const gain = target.readiness_pct - start;
  if (gain === 0) return { start, gain, label: null };
  return { start, gain, label: gain > 0 ? strings.targetGainUp(gain) : strings.targetGainDown(-gain) };
}

/** The sessions budget as the card counts it: what it is once set, else the offer. A rest day
 *  and the date itself have none. */
function sessionBudget(target: TargetSummary): number {
  const { today } = target;
  if (today.state === 'rest' || today.state === 'due_today') return 0;
  return today.sessions_budget ?? today.sessions_offer;
}

/** Phase 65 (spec D7). Today's sessions as dots: done, still to do, faded when the work ran out
 *  before the budget, and bonus for the sessions past it. */
export function sessionDots(target: TargetSummary): ('done' | 'todo' | 'faded' | 'bonus')[] {
  const { today } = target;
  // Phase 71 (spec D4): the eve draws a bar a word instead.
  if (today.state === 'due_today' || isEve(target)) return [];
  const budget = sessionBudget(target);
  const done = Math.min(today.sessions_done, budget);
  const rest = budget - done;
  return [
    ...Array<'done'>(done).fill('done'),
    ...Array<'todo' | 'faded'>(rest).fill(today.ended_early ? 'faded' : 'todo'),
    ...Array<'bonus'>(today.sessions_done - done).fill('bonus'),
  ];
}

/** Phase 65 (spec D7), phase 67b (spec D7, Victor). The words beside the dots. While the day's
 *  goal is not met, grey: the goal before its first session, a good start, almost there. Once it
 *  is met (or the work ran out), blue ↑ while another session can raise the card, green ✓ when
 *  nothing more can today, and "you did it" at 100%, a rest day too. `sub` is the line under it;
 *  `side` the minutes before the first session, the bonus or what ended the day early. Empty
 *  text where the card says nothing of sessions (a rest day, the date). */
export type SessionsLine = {
  kind: 'offer' | 'progress' | 'one_left' | 'met_more' | 'met_done' | 'all_ready' | 'rest' | 'none' | 'eve_words' | 'eve_check';
  text: string;
  sub: string | null;
  /** Phase 71: `strong`, the eve's words line, dark grey and bold. */
  tone: 'plain' | 'strong' | 'more' | 'done';
  side: string | null;
};

/** Phase 71 (spec D4, Victor's mock). The eve's row: the words below their bar and the ready ones
 *  beside them; every word ready, the check cards still owed, then "you did it". */
function eveLine(target: TargetSummary): SessionsLine {
  const missing = target.word_count - target.ready_count;
  if (missing > 0) {
    return {
      kind: 'eve_words',
      text: strings.targetEveWords(missing),
      sub: null,
      tone: 'strong',
      side: strings.targetEveReady(target.ready_count, target.word_count),
    };
  }
  return target.today.state === 'owed' ? plainLine('eve_check', strings.targetEveCheck) : allReadyLine(null);
}

/** Phase 71 (spec D4). The eve's bars, a word each: its readiness as the card counts it, full and
 *  ready at 100; the ready words first, then the strongest first. None on any other day. */
export function wordBars(target: TargetSummary): { pct: number; ready: boolean }[] {
  if (!isEve(target)) return [];
  return [...target.word_readiness].sort((a, b) => b - a).map((pct) => ({ pct, ready: pct >= 100 }));
}

const plainLine = (kind: SessionsLine['kind'], text: string, side: string | null = null): SessionsLine => ({
  kind,
  text,
  sub: null,
  tone: 'plain',
  side,
});
const allReadyLine = (side: string | null): SessionsLine => ({
  kind: 'all_ready',
  text: strings.targetSessionsAllReady,
  sub: null,
  tone: 'done',
  side,
});

export function sessionsLine(target: TargetSummary): SessionsLine {
  const { today } = target;
  const budget = sessionBudget(target);
  const bonus = Math.max(0, today.sessions_done - budget);
  const bonusSide = bonus > 0 ? strings.targetSessionsBonus(bonus) : null;
  const full = target.readiness_pct >= 100;
  if (today.state === 'due_today') return plainLine('none', '');
  if (isEve(target)) return eveLine(target);
  if (today.state === 'rest') return full ? allReadyLine(bonusSide) : plainLine('rest', '', bonusSide);
  // A day that is done reads as met whether or not the budget was ever set.
  if (today.state === 'done') {
    const side =
      today.ended_early && today.sessions_budget !== null ? strings.targetSessionsEarly(today.sessions_done, budget) : bonusSide;
    if (full) return allReadyLine(side);
    return target.practice_more_little
      ? { kind: 'met_done', text: strings.targetSessionsMetDone, sub: strings.targetSessionsMetDoneSub, tone: 'done', side }
      : { kind: 'met_more', text: strings.targetSessionsMetMore, sub: strings.targetSessionsMetMoreSub, tone: 'more', side };
  }
  if (budget === 0) return plainLine('none', '');
  if (today.sessions_done === 0) return plainLine('offer', strings.targetSessionsGoal(budget), strings.targetSessionsMinutes(today.minutes));
  const left = budget - today.sessions_done;
  if (left <= 1) return plainLine('one_left', strings.targetSessionsOneLeft);
  return plainLine('progress', strings.targetSessionsGoodStart(left));
}

/** What a screen reader says of each line, its mark left out. */
const SPOKEN: Partial<Record<SessionsLine['kind'], string>> = {
  met_more: strings.targetSessionsMetMoreSpoken,
  met_done: strings.targetSessionsMetDoneSpoken,
  all_ready: strings.targetSessionsAllReadySpoken,
};

/** Phase 65 (spec D5, final review), phase 67b (spec D7). What a screen reader says of today's
 *  sessions row, whose dots it does not read: the goal as the card writes it, with its minutes;
 *  else the line's words without their mark, the line under it, and the count the dots draw ("3
 *  מתוך 5 תרגולים היום", with the bonus past the budget); on a rest day only its bonus, if any. */
export function sessionsSpoken(target: TargetSummary): string {
  const line = sessionsLine(target);
  const dots = sessionDots(target);
  const count = strings.targetSessionsSpoken(
    dots.filter((dot) => dot === 'done').length,
    sessionBudget(target),
    dots.filter((dot) => dot === 'bonus').length,
  );
  switch (line.kind) {
    case 'offer':
    case 'eve_words':
      return `${line.text}, ${line.side}`;
    case 'eve_check':
      return line.text;
    case 'progress':
    case 'one_left':
      return `${line.text}, ${count}`;
    case 'met_more':
    case 'met_done':
      return `${SPOKEN[line.kind]}, ${line.sub}, ${count}`;
    case 'all_ready':
      return target.today.state === 'rest' ? [SPOKEN.all_ready, line.side].filter(Boolean).join(', ') : `${SPOKEN.all_ready}, ${count}`;
    case 'rest':
    case 'none':
      return line.side ?? '';
  }
}

/** Phase 65 (spec D6). A tapped word's counted skills, in the order the server counts them: the
 *  name, the chance out of 100, whether it is ready, and the note under a held skill. */
export function skillRows(word: TargetWord): {
  dimension: TargetWord['skills'][number]['dimension'];
  name: string;
  chance: number;
  ready: boolean;
  note: string | null;
}[] {
  return word.skills.map((skill) => ({
    dimension: skill.dimension,
    name: strings.dimensionName(skill.dimension),
    chance: skill.chance,
    ready: skill.chance >= READINESS_WORD_READY,
    note: skill.held ? strings.targetSkillHeld : null,
  }));
}

/** Phase 65 (spec D9), phase 67b (spec D8). "לתרגל עוד" asks first when today's sessions are
 *  done, no session today can raise the card (server-computed), the card is below 100% and the
 *  learner has not turned the ask off. */
export function askBeforePracticeMore(target: TargetSummary, optedOut: boolean): boolean {
  return target.today.state === 'done' && target.practice_more_little && target.readiness_pct < 100 && !optedOut;
}

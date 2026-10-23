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
// Hebrew, like every string the app shows.
export const REMINDER_TITLE = 'הגיע הזמן לתרגל';
export const REMINDER_BODY = 'כמה דקות עכשיו, והמילים נשארות בזיכרון.';

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

/**
 * Phase 75 (spec D1). A path of the learner's day as a reminder reads it: an active target, from
 * the read home's card is drawn from (so its numbers are the card's), or My words of a course.
 * `language` is the course's target language code.
 */
export type TargetPath = {
  kind: 'exam' | 'homework';
  enrollmentId: string;
  language: string;
  targetId: string;
  daysLeft: number;
  state: 'owed' | 'done' | 'rest' | 'due_today';
  wordCount: number;
  readyCount: number;
  readinessPct: number;
  sessionsOffer: number;
  sessionsDone: number;
  minutes: number;
};
export type MyWordsPath = {
  kind: 'my_words';
  enrollmentId: string;
  language: string;
  /** Null when the learner turned the goal off. */
  goal: number | null;
  sessionsDone: number;
  /** The words waiting for review: home's "N מילים מחכות לחזרה". */
  waiting: number;
  /** The course's words of its own; at 0 home's card sends the learner to Words for me. */
  saved: number;
};
export type ReminderPath = TargetPath | MyWordsPath;

/** The path a reminder is about, and its rank (spec D2). */
export type ReminderChoice = { path: ReminderPath; rank: 1 | 2 | 3 };

/** The side picture's name: apps/mobile/public/notifications/<name>.png (spec D4). */
export type ReminderImage = 'exam' | 'exam-urgent' | 'homework' | 'homework-urgent' | 'my-words';

/** A path's rank while it owes something today, else null: a target due tomorrow, another
 *  target, My words short of its goal. Nothing is owed on the date itself, on a rest day, once
 *  the day is done, by a target with no word left, or by My words with no word of its own (spec
 *  D1: a course nobody practises would be reminded at every slot). */
function rankOf(path: ReminderPath): 1 | 2 | 3 | null {
  if (path.kind === 'my_words') return path.goal !== null && path.sessionsDone < path.goal && path.saved > 0 ? 3 : null;
  if (path.state !== 'owed' || path.wordCount === 0 || path.daysLeft < 1) return null;
  return path.daysLeft === 1 ? 1 : 2;
}

/**
 * Phase 75 (spec D2, Victor). The one path a reminder is about: the lowest rank, a test before
 * homework at every rank, then the nearest date, then the order the paths came in. Null when
 * nothing is owed on any path.
 */
export function chooseReminder(paths: readonly ReminderPath[]): ReminderChoice | null {
  const owed = paths.flatMap((path, index) => {
    const rank = rankOf(path);
    return rank === null ? [] : [{ path, rank, index }];
  });
  const key = ({ path, rank, index }: (typeof owed)[number]): number[] => [
    rank,
    path.kind === 'exam' ? 0 : 1,
    path.kind === 'my_words' ? 0 : path.daysLeft,
    index,
  ];
  owed.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    const at = ka.findIndex((value, i) => value !== kb[i]);
    return at === -1 ? 0 : ka[at] - kb[at];
  });
  return owed.length === 0 ? null : { path: owed[0].path, rank: owed[0].rank };
}

// The app's names for a course's language (apps/mobile/src/strings.ts), for a learner with two.
const LANGUAGE_NAMES: Record<string, string> = { he: 'עברית', en: 'אנגלית', ru: 'רוסית', it: 'איטלקית' };
const KIND_THE: Record<TargetPath['kind'], string> = { exam: 'הבוחן', homework: 'שיעורי הבית' };
const KIND_FOR: Record<TargetPath['kind'], string> = { exam: 'לבוחן', homework: 'לשיעורי הבית' };

const sessions = (count: number): string => (count === 1 ? 'תרגול אחד' : `${count} תרגולים`);

function targetBody(path: TargetPath, rank: 1 | 2): string {
  if (rank === 1) {
    const short = path.wordCount - path.readyCount;
    if (short <= 0) return 'כל המילים מוכנות · נשארה בדיקה אחרונה לפני מחר';
    const words = short === 1 ? 'מילה אחת צריכה חיזוק' : `${short} מילים צריכות חיזוק`;
    return `${words} · מוכנות ${KIND_FOR[path.kind]}: ${path.readinessPct}%`;
  }
  const left = path.sessionsOffer - path.sessionsDone;
  if (path.sessionsOffer > 0 && path.sessionsDone === 0) {
    const minutes = path.minutes > 0 ? ` · כ-${path.minutes} דקות` : '';
    return `היעד של היום: ${sessions(path.sessionsOffer)}${minutes}`;
  }
  if (path.sessionsOffer > 0 && left === 1) return 'כמעט שם · עוד תרגול אחד ליעד של היום';
  if (path.sessionsOffer > 0 && left > 1) return `התחלה טובה · עוד ${left} ליעד של היום`;
  return 'נשאר תרגול להיום';
}

function myWordsBody(path: MyWordsPath): string {
  const goal = path.goal ?? 0;
  if (path.sessionsDone === 0) {
    const waiting =
      path.waiting === 0 ? '' : path.waiting === 1 ? ' · מילה אחת מחכה לחזרה' : ` · ${path.waiting} מילים מחכות לחזרה`;
    return `היעד של היום: ${sessions(goal)}${waiting}`;
  }
  const left = goal - path.sessionsDone;
  return left === 1 ? 'כל הכבוד! עוד תרגול אחד להיום' : `כל הכבוד! עוד ${left} תרגולים להיום`;
}

/**
 * Phase 75 (spec D3, D4). A reminder's words and picture, in Hebrew like every string the app
 * shows, reusing the home cards' lines. `withLanguage` names the course after the kind, for a
 * learner with more than one.
 */
export function reminderMessage(choice: ReminderChoice, opts: { withLanguage: boolean }): { title: string; body: string; image: ReminderImage } {
  const { path, rank } = choice;
  const language = opts.withLanguage ? ` ב${LANGUAGE_NAMES[path.language] ?? path.language}` : '';
  if (path.kind === 'my_words') return { title: `המילים שלי${language}`, body: myWordsBody(path), image: 'my-words' };
  const targetRank = rank === 1 ? 1 : 2;
  const when = targetRank === 1 ? 'מחר' : `בעוד ${path.daysLeft} ימים`;
  const urgent = targetRank === 1 && path.wordCount > path.readyCount;
  return {
    title: `${KIND_THE[path.kind]}${language} ${when}`,
    body: targetBody(path, targetRank),
    image: urgent ? `${path.kind}-urgent` : path.kind,
  };
}

/** Phase 75 (spec D5). A path as the decision log records it, in the log's snake case. */
export function pathEvidence(path: ReminderPath): Record<string, string | number | null> {
  if (path.kind === 'my_words') {
    return {
      enrollment_id: path.enrollmentId,
      target_id: null,
      kind: path.kind,
      goal: path.goal,
      sessions_done: path.sessionsDone,
      waiting: path.waiting,
      saved: path.saved,
    };
  }
  return {
    enrollment_id: path.enrollmentId,
    target_id: path.targetId,
    kind: path.kind,
    state: path.state,
    days_left: path.daysLeft,
    word_count: path.wordCount,
    ready_count: path.readyCount,
    readiness_pct: path.readinessPct,
    sessions_offer: path.sessionsOffer,
    sessions_done: path.sessionsDone,
  };
}

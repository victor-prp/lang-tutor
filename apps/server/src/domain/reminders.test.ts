import { describe, expect, it } from '@jest/globals';

import {
  CATCH_UP_MINUTES,
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_BODY,
  REMINDER_CHANNEL,
  REMINDER_TITLE,
  decide,
  dueSlots,
  normalizeSettings,
  reminderForSession,
  chooseReminder,
  pathEvidence,
  reminderMessage,
  type MarkCandidate,
  type MyWordsPath,
  type ReminderPath,
  type ReminderSettings,
  type TargetPath,
} from './reminders';

// Phase 52 (spec D2, D3, D5, D6). The rules the reminder tick and the finished
// session apply: which slots are due, whether to send, which reminder a session
// counts for. 2026-10-14 is a Wednesday (ISO weekday 3).

const at = (hour: number, minute: number, day = 14) => Date.UTC(2026, 9, day, hour, minute);

const oneSlot: ReminderSettings = { enabled: true, dailyTarget: 1, days: [1, 2, 3, 4, 5, 6, 7], times: ['13:00'] };

describe('the fixed values', () => {
  it('are the defaults the spec names', () => {
    expect(DEFAULT_REMINDER_SETTINGS).toEqual({
      enabled: true,
      dailyTarget: 1,
      days: [1, 2, 3, 4, 5, 6, 7],
      times: ['13:00', '17:00', '20:00', '22:00'],
    });
    expect(CATCH_UP_MINUTES).toBe(30);
    expect(REMINDER_CHANNEL).toBe('reminders');
    expect(REMINDER_TITLE).toBe('הגיע הזמן לתרגל');
    expect(REMINDER_BODY).toBe('כמה דקות עכשיו, והמילים נשארות בזיכרון.');
  });
});

describe('dueSlots', () => {
  it('is due at the minute the slot starts', () => {
    expect(dueSlots(oneSlot, 'UTC', at(13, 0))).toEqual([{ localDay: '2026-10-14', slot: '13:00' }]);
  });

  it('is still due 29 minutes after the slot, so a missed tick is caught up', () => {
    expect(dueSlots(oneSlot, 'UTC', at(13, 29))).toEqual([{ localDay: '2026-10-14', slot: '13:00' }]);
  });

  it('is not due 30 minutes after the slot', () => {
    expect(dueSlots(oneSlot, 'UTC', at(13, 30))).toEqual([]);
  });

  it('is not due the minute before the slot', () => {
    expect(dueSlots(oneSlot, 'UTC', at(12, 59))).toEqual([]);
  });

  it('is empty on a weekday the learner left out', () => {
    // Wednesday is 3.
    expect(dueSlots({ ...oneSlot, days: [1, 2, 4, 5, 6, 7] }, 'UTC', at(13, 0))).toEqual([]);
  });

  it('is due on a weekday the learner kept', () => {
    expect(dueSlots({ ...oneSlot, days: [3] }, 'UTC', at(13, 0))).toHaveLength(1);
  });

  it('is empty when no day is chosen', () => {
    expect(dueSlots({ ...oneSlot, days: [] }, 'UTC', at(13, 0))).toEqual([]);
  });

  it('is empty when reminders are off', () => {
    expect(dueSlots({ ...oneSlot, enabled: false }, 'UTC', at(13, 0))).toEqual([]);
  });

  it('is empty when no time is chosen', () => {
    expect(dueSlots({ ...oneSlot, times: [] }, 'UTC', at(13, 0))).toEqual([]);
  });

  it('follows the default settings in UTC, for a learner who never reported a zone', () => {
    expect(dueSlots(DEFAULT_REMINDER_SETTINGS, 'UTC', at(17, 5))).toEqual([{ localDay: '2026-10-14', slot: '17:00' }]);
    expect(dueSlots(DEFAULT_REMINDER_SETTINGS, 'UTC', at(15, 0))).toEqual([]);
  });

  it('returns both slots when two start inside one window', () => {
    const settings = { ...oneSlot, times: ['13:00', '13:15'] };
    expect(dueSlots(settings, 'UTC', at(13, 20))).toEqual([
      { localDay: '2026-10-14', slot: '13:00' },
      { localDay: '2026-10-14', slot: '13:15' },
    ]);
  });

  it('does not return a slot that has not started yet beside one that has', () => {
    const settings = { ...oneSlot, times: ['13:00', '13:15'] };
    expect(dueSlots(settings, 'UTC', at(13, 10))).toEqual([{ localDay: '2026-10-14', slot: '13:00' }]);
  });

  it('returns slots in ascending time order from unsorted input', () => {
    const settings = { ...oneSlot, times: ['13:15', '13:00'] };
    expect(dueSlots(settings, 'UTC', at(13, 20)).map((d) => d.slot)).toEqual(['13:00', '13:15']);
  });

  it('reads the slot on the learner\'s clock and names the learner\'s day', () => {
    // 22:20Z on Wednesday is 01:20 on Thursday in Jerusalem (UTC+3 in October).
    const settings = { ...oneSlot, times: ['01:00'], days: [4] };
    expect(dueSlots(settings, 'Asia/Jerusalem', at(22, 20))).toEqual([{ localDay: '2026-10-15', slot: '01:00' }]);
    expect(dueSlots({ ...settings, days: [3] }, 'Asia/Jerusalem', at(22, 20))).toEqual([]);
  });

  it('does not carry a late-evening slot over midnight', () => {
    // 23:50 is not due at 00:10 the next day: the window never leaves its day.
    expect(dueSlots({ ...oneSlot, times: ['23:50'] }, 'UTC', at(0, 10, 15))).toEqual([]);
  });
});

describe('decide', () => {
  const evidence = (completedToday: number) => ({
    completed_today: completedToday,
    daily_target: 1,
    time_zone: 'UTC',
    devices: 2,
  });

  it('skips once the target is met', () => {
    expect(decide({ completedToday: 1, dailyTarget: 1, timeZone: 'UTC', devices: 2 })).toEqual({
      kind: 'skip_target_met',
      evidence: evidence(1),
    });
  });

  it('skips when the learner did more than the target', () => {
    expect(decide({ completedToday: 3, dailyTarget: 1, timeZone: 'UTC', devices: 2 }).kind).toBe('skip_target_met');
  });

  it('sends while the target is not met', () => {
    expect(decide({ completedToday: 0, dailyTarget: 1, timeZone: 'UTC', devices: 2 })).toEqual({
      kind: 'send',
      evidence: evidence(0),
    });
  });

  it('sends one short of a larger target', () => {
    expect(decide({ completedToday: 2, dailyTarget: 3, timeZone: 'UTC', devices: 2 }).kind).toBe('send');
  });
});

describe('reminderForSession', () => {
  const candidate = (id: string, decidedAt: number, sessionId: string | null = null): MarkCandidate => ({
    id,
    decidedAt,
    sessionId,
  });

  it('is the latest reminder before now', () => {
    const candidates = [candidate('a', at(13, 0)), candidate('b', at(17, 0))];
    expect(reminderForSession(candidates, at(18, 0))).toBe('b');
  });

  it('does not depend on the order of the list', () => {
    const candidates = [candidate('b', at(17, 0)), candidate('a', at(13, 0))];
    expect(reminderForSession(candidates, at(18, 0))).toBe('b');
  });

  it('ignores a reminder decided after now', () => {
    const candidates = [candidate('a', at(13, 0)), candidate('b', at(20, 0))];
    expect(reminderForSession(candidates, at(18, 0))).toBe('a');
  });

  it('counts a reminder decided at the very instant', () => {
    expect(reminderForSession([candidate('a', at(13, 0))], at(13, 0))).toBe('a');
  });

  it('is null when the latest is already marked, even though an earlier one is not', () => {
    const candidates = [candidate('a', at(13, 0)), candidate('b', at(17, 0), 'session-1')];
    expect(reminderForSession(candidates, at(18, 0))).toBeNull();
  });

  it('is null when the only reminder is after now', () => {
    expect(reminderForSession([candidate('a', at(20, 0))], at(18, 0))).toBeNull();
  });

  it('is null for an empty list', () => {
    expect(reminderForSession([], at(18, 0))).toBeNull();
  });
});

describe('normalizeSettings', () => {
  it('sorts and dedupes days and times', () => {
    const settings: ReminderSettings = {
      enabled: true,
      dailyTarget: 2,
      days: [5, 1, 5, 3],
      times: ['20:00', '09:30', '20:00', '13:00'],
    };
    expect(normalizeSettings(settings)).toEqual({
      enabled: true,
      dailyTarget: 2,
      days: [1, 3, 5],
      times: ['09:30', '13:00', '20:00'],
    });
  });

  it('sorts days numerically, not as text', () => {
    expect(normalizeSettings({ ...oneSlot, days: [7, 10, 2] }).days).toEqual([2, 7, 10]);
  });

  it('leaves the input untouched', () => {
    const settings: ReminderSettings = { ...oneSlot, days: [3, 1], times: ['20:00', '13:00'] };
    normalizeSettings(settings);
    expect(settings.days).toEqual([3, 1]);
    expect(settings.times).toEqual(['20:00', '13:00']);
  });
});

// Phase 75 (spec D2, D3). Which path a reminder is about, and its words.

const target = (over: Partial<TargetPath> = {}): TargetPath => ({
  kind: 'homework',
  enrollmentId: 'e_it',
  language: 'it',
  targetId: 't_1',
  daysLeft: 1,
  state: 'owed',
  wordCount: 9,
  readyCount: 3,
  readinessPct: 40,
  sessionsOffer: 2,
  sessionsDone: 0,
  minutes: 6,
  ...over,
});
const myWords = (over: Partial<MyWordsPath> = {}): MyWordsPath => ({
  kind: 'my_words',
  enrollmentId: 'e_it',
  language: 'it',
  goal: 3,
  sessionsDone: 0,
  waiting: 12,
  saved: 20,
  ...over,
});

describe('chooseReminder', () => {
  it('chooses nothing when there is no path', () => {
    expect(chooseReminder([])).toBeNull();
  });

  it('puts a target due tomorrow first, then another owed target, then My words', () => {
    const eve = target({ targetId: 't_eve', daysLeft: 1 });
    const later = target({ targetId: 't_later', daysLeft: 3 });
    const words = myWords();
    expect(chooseReminder([words, later, eve])).toEqual({ path: eve, rank: 1 });
    expect(chooseReminder([words, later])).toEqual({ path: later, rank: 2 });
    expect(chooseReminder([words])).toEqual({ path: words, rank: 3 });
  });

  it('puts a test before homework at every rank, even homework due sooner', () => {
    const homework = target({ targetId: 't_hw', kind: 'homework', daysLeft: 2 });
    const exam = target({ targetId: 't_exam', kind: 'exam', daysLeft: 5 });
    expect(chooseReminder([homework, exam])?.path).toBe(exam);
    const homeworkEve = target({ targetId: 't_hw', kind: 'homework', daysLeft: 1 });
    const examEve = target({ targetId: 't_exam', kind: 'exam', daysLeft: 1 });
    expect(chooseReminder([homeworkEve, examEve])?.path).toBe(examEve);
  });

  it('takes the nearest date within a kind, then the order the paths came in', () => {
    const far = target({ targetId: 't_far', daysLeft: 6 });
    const near = target({ targetId: 't_near', daysLeft: 3 });
    const twin = target({ targetId: 't_twin', daysLeft: 3 });
    expect(chooseReminder([far, near, twin])?.path).toBe(near);
  });

  it('ranks across courses: an owed target in one beats My words in the other', () => {
    const englishWords = myWords({ enrollmentId: 'e_en', language: 'en' });
    const italianHomework = target({ enrollmentId: 'e_it', daysLeft: 4 });
    expect(chooseReminder([englishWords, italianHomework])?.path).toBe(italianHomework);
  });

  it('finds nothing owed in a target done, resting, due today or without words', () => {
    expect(
      chooseReminder([
        target({ state: 'done' }),
        target({ state: 'rest', daysLeft: 3 }),
        target({ state: 'due_today', daysLeft: 0 }),
        target({ wordCount: 0, readyCount: 0 }),
      ]),
    ).toBeNull();
  });

  it('finds nothing owed in My words of a course with no words of its own', () => {
    expect(chooseReminder([myWords({ saved: 0, waiting: 0 })])).toBeNull();
  });

  it('finds nothing owed in My words with its goal off or met', () => {
    expect(chooseReminder([myWords({ goal: null }), myWords({ goal: 3, sessionsDone: 3 }), myWords({ goal: 2, sessionsDone: 4 })])).toBeNull();
  });
});

describe('reminderMessage', () => {
  const say = (path: ReminderPath, rank: 1 | 2 | 3, withLanguage = false) => reminderMessage({ path, rank }, { withLanguage });

  it('names a test due tomorrow with words below the bar, in amber', () => {
    expect(say(target({ kind: 'exam', wordCount: 10, readyCount: 4, readinessPct: 72 }), 1)).toEqual({
      title: 'הבוחן מחר',
      body: '6 מילים צריכות חיזוק · מוכנות לבוחן: 72%',
      image: 'exam-urgent',
    });
  });

  it('says one word in the singular, for homework', () => {
    expect(say(target({ wordCount: 5, readyCount: 4, readinessPct: 81 }), 1)).toEqual({
      title: 'שיעורי הבית מחר',
      body: 'מילה אחת צריכה חיזוק · מוכנות לשיעורי הבית: 81%',
      image: 'homework-urgent',
    });
  });

  it('names the last check when every word is ready the day before, in blue', () => {
    expect(say(target({ kind: 'exam', wordCount: 8, readyCount: 8 }), 1)).toEqual({
      title: 'הבוחן מחר',
      body: 'כל המילים מוכנות · נשארה בדיקה אחרונה לפני מחר',
      image: 'exam',
    });
  });

  it("names a later target's goal for today and its minutes, before any session", () => {
    expect(say(target({ daysLeft: 2, sessionsOffer: 1, sessionsDone: 0, minutes: 3 }), 2)).toEqual({
      title: 'שיעורי הבית בעוד 2 ימים',
      body: 'היעד של היום: תרגול אחד · כ-3 דקות',
      image: 'homework',
    });
    expect(say(target({ kind: 'exam', daysLeft: 3, sessionsOffer: 2, minutes: 6 }), 2).body).toBe('היעד של היום: 2 תרגולים · כ-6 דקות');
  });

  it('leaves the minutes out when there are none', () => {
    expect(say(target({ daysLeft: 2, sessionsOffer: 2, minutes: 0 }), 2).body).toBe('היעד של היום: 2 תרגולים');
  });

  it("counts what is left of today's goal once a session is done", () => {
    expect(say(target({ kind: 'exam', daysLeft: 3, sessionsOffer: 2, sessionsDone: 1 }), 2).body).toBe(
      'כמעט שם · עוד תרגול אחד ליעד של היום',
    );
    expect(say(target({ daysLeft: 3, sessionsOffer: 3, sessionsDone: 1 }), 2).body).toBe('התחלה טובה · עוד 2 ליעד של היום');
  });

  it('says a session is left when the day is owed with no offer to count by', () => {
    expect(say(target({ daysLeft: 3, sessionsOffer: 0 }), 2).body).toBe('נשאר תרגול להיום');
    expect(say(target({ daysLeft: 3, sessionsOffer: 2, sessionsDone: 2 }), 2).body).toBe('נשאר תרגול להיום');
  });

  it("names My words' goal and the words waiting, before any session", () => {
    expect(say(myWords(), 3)).toEqual({
      title: 'המילים שלי',
      body: 'היעד של היום: 3 תרגולים · 12 מילים מחכות לחזרה',
      image: 'my-words',
    });
    expect(say(myWords({ goal: 1, waiting: 1 }), 3).body).toBe('היעד של היום: תרגול אחד · מילה אחת מחכה לחזרה');
    expect(say(myWords({ waiting: 0 }), 3).body).toBe('היעד של היום: 3 תרגולים');
  });

  it("counts what is left of My words' goal once a session is done", () => {
    expect(say(myWords({ sessionsDone: 2 }), 3).body).toBe('כל הכבוד! עוד תרגול אחד להיום');
    expect(say(myWords({ sessionsDone: 1 }), 3).body).toBe('כל הכבוד! עוד 2 תרגולים להיום');
  });

  it('names the course when the learner has two', () => {
    expect(say(target({ kind: 'exam' }), 1, true).title).toBe('הבוחן באיטלקית מחר');
    expect(say(target({ language: 'en', daysLeft: 2 }), 2, true).title).toBe('שיעורי הבית באנגלית בעוד 2 ימים');
    expect(say(myWords({ language: 'en' }), 3, true).title).toBe('המילים שלי באנגלית');
  });
});

describe('pathEvidence', () => {
  it("records a target's numbers and My words' goal, in the log's snake case", () => {
    expect(pathEvidence(target())).toEqual({
      enrollment_id: 'e_it',
      target_id: 't_1',
      kind: 'homework',
      state: 'owed',
      days_left: 1,
      word_count: 9,
      ready_count: 3,
      readiness_pct: 40,
      sessions_offer: 2,
      sessions_done: 0,
    });
    expect(pathEvidence(myWords({ sessionsDone: 1 }))).toEqual({
      enrollment_id: 'e_it',
      target_id: null,
      kind: 'my_words',
      goal: 3,
      sessions_done: 1,
      waiting: 12,
      saved: 20,
    });
  });
});

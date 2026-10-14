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
  type MarkCandidate,
  type ReminderSettings,
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
    expect(REMINDER_TITLE).toBe('Time to practise');
    expect(REMINDER_BODY).toBe('A few minutes now keeps your words fresh.');
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

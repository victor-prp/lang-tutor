import { describe, expect, it, jest } from '@jest/globals';
import type { TargetList } from '@lang-tutor/core/api';

import {
  dueDateChoices,
  daysLeftLabel,
  readinessName,
  readyLabel,
  targetTitle,
  targetsFor,
  type StoredTargets,
} from './targets';

// U+2066 ... U+2069, as strings.ts wraps every number.
const ltr = (text: string) => `\u2066${text}\u2069`;

describe('dueDateChoices', () => {
  it('offers the 60 days after today, the first of them tomorrow', () => {
    const choices = dueDateChoices('2026-10-15');
    expect(choices).toHaveLength(60);
    expect(choices[0].day).toBe('2026-10-16');
    expect(choices[59].day).toBe('2026-12-14');
    expect(choices.map((choice) => choice.day)).not.toContain('2026-10-15');
  });

  it('is one day after another, none skipped or repeated', () => {
    const days = dueDateChoices('2026-10-15').map((choice) => choice.day);
    expect(new Set(days).size).toBe(60);
    expect([...days].sort()).toEqual(days);
  });

  it('takes the count it is given', () => {
    expect(dueDateChoices('2026-10-15', 3).map((choice) => choice.day)).toEqual([
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    expect(dueDateChoices('2026-10-15', 0)).toEqual([]);
  });

  it('carries over the end of a month, of a year, and a leap day', () => {
    expect(dueDateChoices('2026-10-31', 1)[0].day).toBe('2026-11-01');
    expect(dueDateChoices('2026-12-31', 1)[0].day).toBe('2027-01-01');
    expect(dueDateChoices('2028-02-28', 2).map((choice) => choice.day)).toEqual(['2028-02-29', '2028-03-01']);
    expect(dueDateChoices('2026-02-28', 1)[0].day).toBe('2026-03-01');
    // 2100 is a century year the calendar does not make a leap year.
    expect(dueDateChoices('2100-02-28', 1)[0].day).toBe('2100-03-01');
  });

  // The server's learner day is the only today there is (ADR 0013): a phone's own
  // date, which may be another day or another time zone, must not move the list.
  it('reads no clock: only the day it is given decides', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2030-06-15T12:00:00Z'));
      expect(dueDateChoices('2026-10-15', 2).map((choice) => choice.day)).toEqual(['2026-10-16', '2026-10-17']);
      jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
      expect(dueDateChoices('2026-10-15', 2).map((choice) => choice.day)).toEqual(['2026-10-16', '2026-10-17']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('labels each day with its weekday, its date and its month', () => {
    const choices = dueDateChoices('2026-10-15');
    // 2026-10-15 is a Thursday.
    expect(choices[0].label).toBe(`יום שישי, ${ltr('16')} באוקטובר`);
    expect(choices[1].label).toBe(`יום שבת, ${ltr('17')} באוקטובר`);
    expect(choices[2].label).toBe(`יום ראשון, ${ltr('18')} באוקטובר`);
    // No zero is written before a single-digit day.
    expect(choices[16].label).toBe(`יום ראשון, ${ltr('1')} בנובמבר`);
    expect(choices[59].label).toBe(`יום שני, ${ltr('14')} בדצמבר`);
  });

  it('names the weekday of every day of a week', () => {
    const names = dueDateChoices('2026-10-17', 7).map((choice) => choice.label.split(',')[0]);
    expect(names).toEqual(['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'יום שבת']);
  });

  it('names the month of the year it runs into', () => {
    const labels = dueDateChoices('2026-12-31', 1).map((choice) => choice.label);
    expect(labels).toEqual([`יום שישי, ${ltr('1')} בינואר`]);
  });

  it('refuses a today that is not a day', () => {
    expect(() => dueDateChoices('15/10/2026')).toThrow(RangeError);
    expect(() => dueDateChoices('')).toThrow(RangeError);
  });
});

describe('targetTitle', () => {
  it('names the two kinds', () => {
    expect(targetTitle('homework')).toBe('שיעורי בית');
    expect(targetTitle('exam')).toBe('בוחן');
  });
});

describe('daysLeftLabel', () => {
  it('says tomorrow for one day and counts from two', () => {
    expect(daysLeftLabel(1)).toBe('מחר');
    expect(daysLeftLabel(2)).toBe(`בעוד ${ltr('2')} ימים`);
    expect(daysLeftLabel(14)).toBe(`בעוד ${ltr('14')} ימים`);
  });

  it('does not count down from a date that has come', () => {
    expect(daysLeftLabel(0)).toBe('התאריך הגיע');
    expect(daysLeftLabel(-3)).toBe('התאריך הגיע');
  });
});

describe('readyLabel', () => {
  it('counts the ready words of the target, both numbers isolated', () => {
    expect(readyLabel(3, 8)).toBe(`${ltr('3')} מתוך ${ltr('8')} מוכנות`);
    expect(readyLabel(0, 5)).toBe(`${ltr('0')} מתוך ${ltr('5')} מוכנות`);
    expect(readyLabel(12, 12)).toBe(`${ltr('12')} מתוך ${ltr('12')} מוכנות`);
  });
});

describe('readinessName', () => {
  it('names the four levels, from not started to ready', () => {
    expect(readinessName('not_started')).toBe('עוד לא התחלנו');
    expect(readinessName('on_the_way')).toBe('בדרך');
    expect(readinessName('almost')).toBe('כמעט מוכנה');
    expect(readinessName('ready')).toBe('מוכנה');
  });
});

describe('targetsFor', () => {
  const list: TargetList = {
    today: '2026-10-15',
    targets: [{ id: 't1', kind: 'exam', due_on: '2026-10-20', days_left: 5, word_count: 4, ready_count: 1 }],
  };
  const stored: StoredTargets = { enrollmentId: 'e1', list };

  it("shows the list read for the active enrollment, and no other enrollment's", () => {
    expect(targetsFor(stored, 'e1')).toBe(list);
    expect(targetsFor(stored, 'e2')).toBeNull();
  });

  it('shows nothing before a first read, or with no enrollment active', () => {
    expect(targetsFor(null, 'e1')).toBeNull();
    expect(targetsFor(stored, undefined)).toBeNull();
  });
});

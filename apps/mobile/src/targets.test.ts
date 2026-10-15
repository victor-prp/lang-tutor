import { describe, expect, it, jest } from '@jest/globals';
import type { Target, TargetList } from '@lang-tutor/core/api';

import { ApiError } from './api/client';
import {
  actionFailureMessage,
  dateHasCome,
  dueDateChoices,
  dueDayLabel,
  daysLeftLabel,
  doneFailureMessage,
  photosHint,
  readinessName,
  readyLabel,
  stepTitle,
  targetTitle,
  targetsFor,
  withoutWord,
  wizardTitle,
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

describe('dueDayLabel', () => {
  it("labels a target's own date as the date step labels it", () => {
    expect(dueDayLabel('2026-10-16')).toBe(`יום שישי, ${ltr('16')} באוקטובר`);
    expect(dueDayLabel('2027-01-01')).toBe(`יום שישי, ${ltr('1')} בינואר`);
    expect(dueDateChoices('2026-10-15', 60).every((choice) => dueDayLabel(choice.day) === choice.label)).toBe(true);
  });

  it('reads no clock either', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2030-06-15T23:30:00Z'));
      expect(dueDayLabel('2026-10-16')).toBe(`יום שישי, ${ltr('16')} באוקטובר`);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses a day that is not one', () => {
    expect(() => dueDayLabel('16.10.2026')).toThrow(RangeError);
  });
});

describe('wizardTitle and stepTitle', () => {
  it('names the wizard of each action', () => {
    expect(wizardTitle('create')).toBe('הכנה חדשה');
    expect(wizardTitle('add-photos')).toBe('מילים מתמונות');
    expect(wizardTitle('add-words')).toBe('הוספת מילים');
    expect(wizardTitle('change-date')).toBe('שינוי התאריך');
  });

  it('names each step', () => {
    expect(stepTitle('kind')).toBe('למה מתכוננים?');
    expect(stepTitle('photos')).toBe('תמונות של רשימת המילים');
    expect(stepTitle('review')).toBe('המילים מהתמונות');
    expect(stepTitle('words')).toBe('עוד מילים');
    expect(stepTitle('date')).toBe('באיזה תאריך?');
  });
});

describe('photosHint (final review item 32)', () => {
  it('lets a new target skip its photos, and says so', () => {
    expect(photosHint('create')).toBe('אפשר לצלם או לבחור כמה תמונות, או לדלג על השלב.');
  });

  it("says nothing of skipping where Next needs a photo: a target screen's add photos", () => {
    expect(photosHint('add-photos')).toBe('אפשר לצלם או לבחור כמה תמונות.');
    expect(photosHint('add-photos')).not.toContain('לדלג');
  });
});

describe('dateHasCome', () => {
  // The target screen reads a target by id, which may be past its date (spec D11): it is
  // closed then, and offers no change.
  it('is true from the due date on, and false while a day is left', () => {
    expect(dateHasCome({ days_left: 1 })).toBe(false);
    expect(dateHasCome({ days_left: 9 })).toBe(false);
    expect(dateHasCome({ days_left: 0 })).toBe(true);
    expect(dateHasCome({ days_left: -2 })).toBe(true);
  });
});

describe('doneFailureMessage', () => {
  it("says what to fix when the server says why it refused (the 400's reason)", () => {
    expect(doneFailureMessage(new ApiError(400, 'invalid target', 'no_words'))).toBe(
      'צריך לפחות מילה אחת. אפשר לחזור ולהוסיף מילים.',
    );
    expect(doneFailureMessage(new ApiError(400, 'invalid target', 'due_date'))).toBe('צריך לבחור תאריך אחרי היום.');
  });

  it('says the target is closed when it is', () => {
    expect(doneFailureMessage(new ApiError(409, 'target closed'))).toBe('ההכנה הזו כבר הסתיימה.');
  });

  it('says only that it failed for anything else', () => {
    const failed = 'השמירה נכשלה. נסו שוב.';
    expect(doneFailureMessage(new ApiError(400, 'invalid target', 'unknown_import'))).toBe(failed);
    expect(doneFailureMessage(new ApiError(400, 'invalid request'))).toBe(failed);
    expect(doneFailureMessage(new ApiError(409, 'photo import not ready'))).toBe(failed);
    expect(doneFailureMessage(new ApiError(500))).toBe(failed);
    expect(doneFailureMessage(new TypeError('Network request failed'))).toBe(failed);
  });
});

describe('actionFailureMessage', () => {
  it('says the target is closed when it is, and only that it failed otherwise', () => {
    expect(actionFailureMessage(new ApiError(409, 'target closed'))).toBe('ההכנה הזו כבר הסתיימה.');
    expect(actionFailureMessage(new ApiError(404, 'target not found'))).toBe('הפעולה נכשלה. נסו שוב.');
    expect(actionFailureMessage(new TypeError('Network request failed'))).toBe('הפעולה נכשלה. נסו שוב.');
  });
});

describe('withoutWord', () => {
  const target: Target = {
    id: 't1',
    kind: 'exam',
    due_on: '2026-10-20',
    days_left: 5,
    word_count: 3,
    ready_count: 1,
    words: [
      { gloss_id: 'g1', form: 'cane', meaning: 'כלב', readiness: 'ready' },
      { gloss_id: 'g2', form: 'casa', meaning: 'בית', readiness: 'almost' },
      { gloss_id: 'g3', form: 'gatto', meaning: 'חתול', readiness: 'not_started' },
    ],
  };

  it('takes the word out and counts it out, and its readiness out of the ready count', () => {
    expect(withoutWord(target, 'g2')).toEqual({
      ...target,
      word_count: 2,
      ready_count: 1,
      words: [target.words[0], target.words[2]],
    });
    expect(withoutWord(target, 'g1')).toMatchObject({ word_count: 2, ready_count: 0 });
  });

  it('leaves a target without the word as it was, and never changes the one it is given', () => {
    expect(withoutWord(target, 'g9')).toEqual(target);
    withoutWord(target, 'g1');
    expect(target.words).toHaveLength(3);
    expect(target.word_count).toBe(3);
  });
});

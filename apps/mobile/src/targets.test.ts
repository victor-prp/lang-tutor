import { describe, expect, it, jest } from '@jest/globals';
import type { Target, TargetList, TargetSummary, TargetWord } from '@lang-tutor/core/api';

import { ApiError } from './api/client';
import {
  actionFailureMessage,
  countdownBig,
  dateHasCome,
  dotLook,
  fuseOf,
  isUrgent,
  stackBars,
  targetButtonSolid,
  urgencyOf,
  dueDateChoices,
  dueDayLabel,
  daysLeftLabel,
  doneFailureMessage,
  homeOrder,
  askBeforePracticeMore,
  readinessColor,
  readinessName,
  readinessBar,
  skillRows,
  sessionDots,
  sessionsLine,
  sessionsSpoken,
  readyLabel,
  shouldPollTargets,
  stepTitle,
  targetCardState,
  targetTitle,
  targetsFor,
  withoutWord,
  wizardTitle,
  screenGroups,
  wordGroups,
  wordTodayLine,
  groupTitle,
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
  it('writes the percent, its digits isolated', () => {
    expect(readinessName(0)).toBe('\u20660%\u2069');
    expect(readinessName(85)).toBe('\u206685%\u2069');
    expect(readinessName(88)).toBe('\u206688%\u2069');
  });

  // Phase 65: a word is ready from READINESS_WORD_READY (90).
  it('says ready from 90%', () => {
    expect(readinessName(89)).toBe('\u206689%\u2069');
    expect(readinessName(90)).toBe('מוכנה');
    expect(readinessName(100)).toBe('מוכנה');
  });
});

const WORD = { gloss_id: 'g0', form: '', meaning: '', readiness_pct: 0, today: 'owed' as const, owed: [], starts_in: null, skills: [] };
const DAY = {
  readiness_pct: 0,
  readiness_start_pct: 0,
  practice_more_little: false,
  today: { state: 'owed' as const, done: 0, planned: 0, extra: 0, next_practice_in: null, sessions_budget: null, sessions_offer: 0, sessions_done: 0, ended_early: false, minutes: 0 },
  session: null,
};

describe('targetsFor', () => {
  const list: TargetList = {
    today: '2026-10-15',
    targets: [{ id: 't1', kind: 'exam', due_on: '2026-10-20', created_on: '2026-10-10', days_left: 5, word_count: 4, ready_count: 1, ...DAY }],
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
    expect(wizardTitle('photo')).toBe('מילים מתמונות');
    expect(wizardTitle('add-words')).toBe('הוספת מילים');
    expect(wizardTitle('change-date')).toBe('שינוי התאריך');
  });

  it('names each step', () => {
    expect(stepTitle('photos')).toBe('תמונות של רשימת המילים');
    expect(stepTitle('choose')).toBe('מה לעשות עם המילים החדשות?');
    expect(stepTitle('review')).toBe('המילים מהתמונות');
    expect(stepTitle('words')).toBe('עוד מילים');
    expect(stepTitle('date')).toBe('באיזה תאריך?');
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
    created_on: '2026-10-10',
    days_left: 5,
    word_count: 3,
    ready_count: 1,
    ...DAY,
    words: [
      { ...WORD, gloss_id: 'g1', form: 'cane', meaning: 'כלב', readiness_pct: 90 },
      { ...WORD, gloss_id: 'g2', form: 'casa', meaning: 'בית', readiness_pct: 80 },
      { ...WORD, gloss_id: 'g3', form: 'gatto', meaning: 'חתול', readiness_pct: 0 },
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

// Phase 57 (spec D10, D11). Home's cards: their order, what a target's card shows, and colours.
type TodayState = TargetSummary['today']['state'];
const summary = (
  id: string,
  state: TodayState,
  due_on: string,
  over: Partial<Omit<TargetSummary, 'today'>> & { today?: Partial<TargetSummary['today']> } = {},
): TargetSummary => ({
  id,
  kind: 'exam',
  due_on,
  created_on: '2026-10-10',
  days_left: 5,
  word_count: 8,
  ready_count: 0,
  readiness_pct: 18,
  readiness_start_pct: 18,
  practice_more_little: false,
  session: null,
  ...over,
  today: { state, done: 0, planned: 8, extra: 0, next_practice_in: null, sessions_budget: null, sessions_offer: 0, sessions_done: 0, ended_early: false, minutes: 0, ...over.today },
});

describe('homeOrder', () => {
  it('is My words alone with no target, and its button filled', () => {
    expect(homeOrder([])).toEqual({ first: 'main', order: ['main'] });
  });

  it('puts the targets with work owed first, nearest date first, then My words, then the rest by date', () => {
    const targets = [
      summary('rest-late', 'rest', '2026-11-20'),
      summary('owed-late', 'owed', '2026-10-25'),
      summary('done-soon', 'done', '2026-10-18'),
      summary('owed-soon', 'owed', '2026-10-19'),
      summary('rest-soon', 'rest', '2026-10-30'),
    ];
    expect(homeOrder(targets)).toEqual({
      first: 'owed-soon',
      order: ['owed-soon', 'owed-late', 'main', 'done-soon', 'rest-soon', 'rest-late'],
    });
  });

  it('breaks a tie on the date by id, whatever order the list came in', () => {
    const a = summary('a', 'owed', '2026-10-20');
    const b = summary('b', 'owed', '2026-10-20');
    expect(homeOrder([b, a]).order).toEqual(['a', 'b', 'main']);
    expect(homeOrder([a, b]).order).toEqual(['a', 'b', 'main']);
  });

  // Once the exam's work is done, My words moves to the top with the filled button.
  it('fills My words once no target has work owed', () => {
    const targets = [summary('done', 'done', '2026-10-18'), summary('rest', 'rest', '2026-10-17')];
    expect(homeOrder(targets)).toEqual({ first: 'main', order: ['main', 'rest', 'done'] });
  });

  it('puts a target on its date first, ahead of one with work owed (spec D10)', () => {
    const targets = [
      summary('owed', 'owed', '2026-10-17'),
      summary('today', 'due_today', '2026-10-16', { days_left: 0, readiness_pct: 60 }),
    ];
    expect(homeOrder(targets)).toEqual({ first: 'today', order: ['today', 'owed', 'main'] });
  });

  // Final review M3. A target left with no word has no button, so it never takes the filled one.
  it('never fills a target with no word', () => {
    const empty = summary('empty', 'owed', '2026-10-17', { word_count: 0 });
    expect(homeOrder([empty])).toEqual({ first: 'main', order: ['empty', 'main'] });
    expect(homeOrder([empty, summary('owed', 'owed', '2026-10-20')])).toEqual({ first: 'owed', order: ['empty', 'owed', 'main'] });
  });

  // Its last review is outlined at 100%: the next card down has the filled button.
  it('fills the next card when the target on its date is already ready', () => {
    const ready = summary('today', 'due_today', '2026-10-16', { days_left: 0, ready_count: 8, word_count: 8, readiness_pct: 95 });
    expect(homeOrder([ready])).toEqual({ first: 'main', order: ['today', 'main'] });
    expect(homeOrder([ready, summary('owed', 'owed', '2026-10-20')])).toEqual({
      first: 'owed',
      order: ['today', 'owed', 'main'],
    });
  });
});

describe('targetCardState', () => {
  const ltr = (text: string) => `⁦${text}⁩`;

  it('owes work: the countdown and "practise now"', () => {
    const card = targetCardState(summary('t', 'owed', '2026-10-21', { today: { done: 5, planned: 8 } }));
    expect(card).toEqual({
      title: { before: 'בוחן בעוד ', number: ltr('5'), after: ' ימים' },
      note: null,
      readiness: `מוכנות לבוחן: ${ltr('18%')}`,
      button: 'לתרגל עכשיו',
    });
  });

  it('is done: no note, and "practise more"', () => {
    const card = targetCardState(
      summary('t', 'done', '2026-10-21', { days_left: 20, today: { done: 10, planned: 10, extra: 2 } }),
    );
    expect(card.title).toEqual({ before: 'בוחן בעוד ', number: ltr('20'), after: ' ימים' });
    expect(card.note).toBeNull();
    expect(card.button).toBe('לתרגל עוד');
  });

  it('rests: the rest line with the next practice day, and "practise more"', () => {
    const card = targetCardState(
      summary('t', 'rest', '2026-11-02', { days_left: 17, today: { planned: 0, next_practice_in: 3 } }),
    );
    expect(card.note).toEqual({ kind: 'rest', text: `היום אין תרגול לבוחן. התרגול הבא בעוד ${ltr('3')} ימים` });
    expect(card.button).toBe('לתרגל עוד');
  });

  it('is on its date: its own title, good luck and the last review (spec D10)', () => {
    const card = targetCardState(
      summary('t', 'due_today', '2026-10-16', { kind: 'homework', days_left: 0, readiness_pct: 100 }),
    );
    expect(card).toEqual({
      title: { before: 'שיעורי הבית היום', number: null, after: '' },
      note: { kind: 'due-today', text: 'בהצלחה!' },
      readiness: `מוכנות לשיעורי הבית: ${ltr('100%')}`,
      button: 'חזרה אחרונה',
    });
  });

  // Final review M3. A create for a target with no word answers 409: no button to send it.
  it('offers no button when the target has no word, whatever its day', () => {
    for (const state of ['owed', 'done', 'rest', 'due_today'] as const) {
      expect(targetCardState(summary('t', state, '2026-10-21', { word_count: 0 })).button).toBeNull();
    }
  });

  it('says tomorrow for one day left', () => {
    expect(targetCardState(summary('t', 'owed', '2026-10-17', { days_left: 1 })).title).toEqual({
      before: 'בוחן מחר',
      number: null,
      after: '',
    });
  });
});

describe('readinessColor', () => {
  // Red at 0%, through orange and yellow, to green at ready (spec D9).
  it('runs the hue from red at 0 to green at 100', () => {
    expect(readinessColor(0)).toBe('hsl(0, 65%, 42%)');
    expect(readinessColor(50)).toBe('hsl(60, 65%, 42%)');
    expect(readinessColor(100)).toBe('hsl(120, 65%, 42%)');
    expect(readinessColor(18)).toBe('hsl(22, 65%, 42%)');
  });

  it('keeps a percent outside 0-100 at the ends', () => {
    expect(readinessColor(-5)).toBe(readinessColor(0));
    expect(readinessColor(130)).toBe(readinessColor(100));
  });
});

describe('shouldPollTargets', () => {
  const preparing = { session_id: 's1', status: 'preparing' as const, source: 'list' as const, answered: 0, total: 0, started: false };
  const ready = { ...preparing, status: 'ready' as const, total: 4 };

  it("polls while any target's session is preparing", () => {
    const list = (sessions: (typeof preparing | typeof ready | null)[]): TargetList => ({
      today: '2026-10-16',
      targets: sessions.map((session, at) => summary(`t${at}`, 'owed', '2026-10-20', { session })),
    });
    expect(shouldPollTargets(list([ready, preparing]))).toBe(true);
    expect(shouldPollTargets(list([ready, null]))).toBe(false);
    expect(shouldPollTargets(list([]))).toBe(false);
    expect(shouldPollTargets(null)).toBe(false);
  });
});

describe('wordGroups', () => {
  const word = (gloss_id: string, today: TargetWord['today'], over: Partial<TargetWord> = {}): TargetWord => ({
    gloss_id,
    form: gloss_id,
    meaning: 'm',
    readiness_pct: 0,
    today,
    owed: [],
    starts_in: null,
    skills: [],
    ...over,
  });

  it('groups by today in the order owed, done, extra, later, keeping the words order', () => {
    const groups = wordGroups([
      word('a', 'later'),
      word('b', 'owed'),
      word('c', 'done'),
      word('d', 'owed'),
      word('e', 'extra'),
    ]);
    expect(groups.map((group) => group.today)).toEqual(['owed', 'done', 'extra', 'later']);
    expect(groups[0]?.words.map((w) => w.gloss_id)).toEqual(['b', 'd']);
  });

  it('leaves out an empty group', () => {
    expect(wordGroups([word('a', 'done')]).map((group) => group.today)).toEqual(['done']);
    expect(wordGroups([])).toEqual([]);
  });

  it('titles the groups', () => {
    expect(groupTitle('owed')).toBe('נשאר להיום');
    expect(groupTitle('done')).toBe('סיימת להיום');
    expect(groupTitle('extra')).toBe('נוספו היום');
    expect(groupTitle('later')).toBe('בהמשך');
  });

  it("words a row's line", () => {
    expect(wordTodayLine(word('a', 'owed', { owed: ['spelling', 'written_productive'] }))).toBe('היום נשאר: איות, כתיבה');
    expect(wordTodayLine(word('a', 'done'))).toBe('היום ✓');
    expect(wordTodayLine(word('a', 'extra'))).toBe('בונוס ✓');
    expect(wordTodayLine(word('a', 'later', { starts_in: 1 }))).toBe('נתחיל מחר');
    expect(wordTodayLine(word('a', 'later', { starts_in: 3 }))).toBe(`נתחיל בעוד ${ltr('3')} ימים`);
    expect(wordTodayLine(word('a', 'later'))).toBeNull();
  });
});

// Final review M1. The target screen's word list: the groups of the day, each titled and each row
// with its line for today; on the date (spec D10: nothing owed) and after it, the words alone,
// with no title and no line.
describe('screenGroups', () => {
  const word = (gloss_id: string, today: TargetWord['today'], over: Partial<TargetWord> = {}): TargetWord => ({
    gloss_id,
    form: gloss_id,
    meaning: 'm',
    readiness_pct: 0,
    today,
    owed: ['spelling'],
    starts_in: null,
    skills: [],
    ...over,
  });
  const target = (days_left: number, state: TargetSummary['today']['state'], words: TargetWord[]): Target => ({
    ...summary('t', state, '2026-10-21', { days_left }),
    words,
  });

  it('titles the groups of the day and gives each row its line', () => {
    const groups = screenGroups(target(5, 'owed', [word('a', 'owed'), word('b', 'later', { starts_in: 2 })]));
    expect(groups).toEqual([
      { key: 'owed', title: 'נשאר להיום', lines: true, words: [expect.objectContaining({ gloss_id: 'a' })] },
      { key: 'later', title: 'בהמשך', lines: true, words: [expect.objectContaining({ gloss_id: 'b' })] },
    ]);
  });

  it('lists the words alone on the date: nothing is owed, so no title and no line', () => {
    const words = [word('a', 'owed'), word('b', 'done')];
    expect(screenGroups(target(0, 'due_today', words))).toEqual([{ key: 'all', title: null, lines: false, words }]);
    // Read after its date, as an ended target's screen is.
    expect(screenGroups(target(-2, 'due_today', words))).toEqual([{ key: 'all', title: null, lines: false, words }]);
  });

  it('lists nothing for a target with no word', () => {
    expect(screenGroups(target(0, 'due_today', []))).toEqual([]);
    expect(screenGroups(target(5, 'owed', []))).toEqual([]);
  });
});

// Phase 64 (spec D4, D5). The card's blue header: the countdown's big line, the fuse that burns
// from the day the target was made to its date, the "not ready" line of the last two days, the
// button's solid or pale look, and the stack's dots.
describe('countdownBig (phase 64, spec D4)', () => {
  it('is the days left with ימים, then מחר, then היום', () => {
    expect(countdownBig(5)).toEqual({ big: ltr('5'), unit: 'ימים' });
    expect(countdownBig(2)).toEqual({ big: ltr('2'), unit: 'ימים' });
    expect(countdownBig(1)).toEqual({ big: 'מחר', unit: null });
    expect(countdownBig(0)).toEqual({ big: 'היום', unit: null });
  });
});

describe('fuseOf (phase 64, spec D5)', () => {
  const fuse = (created_on: string, due_on: string, days_left: number) => fuseOf({ created_on, due_on, days_left });

  it('is the share of the time left, white before the last two days', () => {
    expect(fuse('2026-10-13', '2026-10-23', 5)).toEqual({ share: 0.5, hot: false, label: null });
  });

  it('turns hot in the last two days, with a label', () => {
    expect(fuse('2026-10-13', '2026-10-23', 1)).toEqual({ share: 0.1, hot: true, label: 'יום אחד' });
    expect(fuse('2026-10-13', '2026-10-23', 0)).toEqual({ share: 0, hot: true, label: 'היום' });
  });

  it('never divides by zero nor runs past whole, for a target made on its date or the day before', () => {
    expect(fuse('2026-10-23', '2026-10-23', 0)).toEqual({ share: 0, hot: true, label: 'היום' });
    expect(fuse('2026-10-22', '2026-10-23', 1)).toEqual({ share: 1, hot: true, label: 'יום אחד' });
    expect(fuse('2026-10-22', '2026-10-23', 3).share).toBe(1);
  });
});

describe('urgencyOf (phase 64, spec D5)', () => {
  const of = (kind: 'exam' | 'homework', days_left: number, word_count: number, ready_count: number) =>
    urgencyOf({ kind, days_left, word_count, ready_count });

  it('names the words not ready in the last two days', () => {
    expect(of('exam', 1, 8, 5)).toEqual({ kind: 'not-ready', text: `הבוחן מחר ו-${ltr('3')} מילים עוד לא מוכנות. עוד תרגול אחד יעזור.` });
    expect(of('homework', 0, 6, 4)).toEqual({ kind: 'not-ready', text: `שיעורי הבית היום ו-${ltr('2')} מילים עוד לא מוכנות. חזרה אחרונה תעזור.` });
    expect(of('exam', 1, 8, 7)).toEqual({ kind: 'not-ready', text: 'הבוחן מחר ומילה אחת עוד לא מוכנה. עוד תרגול אחד יעזור.' });
  });

  it('says every word is ready once none is missing', () => {
    expect(of('exam', 1, 8, 8)).toEqual({ kind: 'ready', text: 'כל המילים מוכנות לבוחן ✓' });
    expect(of('homework', 0, 6, 6)).toEqual({ kind: 'ready', text: 'כל המילים מוכנות לשיעורי הבית ✓' });
  });

  it('says nothing before the last two days, nor for a target with no word', () => {
    expect(of('exam', 2, 8, 0)).toBeNull();
    expect(of('exam', 1, 0, 0)).toBeNull();
  });

  it('marks a card urgent in its last two days', () => {
    expect(isUrgent({ days_left: 2 })).toBe(false);
    expect(isUrgent({ days_left: 1 })).toBe(true);
    expect(isUrgent({ days_left: 0 })).toBe(true);
  });
});

describe('targetButtonSolid (phase 64, spec D4)', () => {
  it('is solid while work is owed, and on the date until every word is ready', () => {
    expect(targetButtonSolid(summary('t', 'owed', '2026-10-20'))).toBe(true);
    expect(targetButtonSolid(summary('t', 'done', '2026-10-20'))).toBe(false);
    expect(targetButtonSolid(summary('t', 'rest', '2026-10-20'))).toBe(false);
    expect(targetButtonSolid(summary('t', 'due_today', '2026-10-15', { ready_count: 7, word_count: 8, readiness_pct: 99 }))).toBe(true);
    expect(targetButtonSolid(summary('t', 'due_today', '2026-10-15', { ready_count: 8, word_count: 8, readiness_pct: 92 }))).toBe(false);
  });
});

// Phase 64b (spec D4). The bars under the cards: a name each up to four cards, with the due
// day's letter when two targets share a kind; from five, the kind's icon and the day.
// 2026-10-18 is a Sunday: the 20th is ג׳, the 22nd ה׳, the 23rd ו׳.
describe('stackBars (phase 64b, spec D4)', () => {
  const exam = summary('t1', 'owed', '2026-10-20', { days_left: 2 });
  const homework = (id: string, due: string, days = 5) => summary(id, 'owed', due, { kind: 'homework', days_left: days });

  it('draws no bars for one card', () => {
    expect(stackBars(['main'], [])).toEqual([]);
  });

  it('names each card, up to four, and says where it is', () => {
    expect(stackBars(['t1', 'main'], [exam])).toEqual([
      { card: 't1', urgent: false, label: 'בוחן', icon: null, spoken: 'בוחן, 1 מתוך 2' },
      { card: 'main', urgent: false, label: 'המילים שלי', icon: null, spoken: 'המילים שלי, 2 מתוך 2' },
    ]);
  });

  it('adds the due day to two targets of a kind', () => {
    const bars = stackBars(['h1', 'h2', 'main'], [homework('h1', '2026-10-22'), homework('h2', '2026-10-23')]);
    expect(bars.map((bar) => bar.label)).toEqual(['שיעורי בית ה׳', 'שיעורי בית ו׳', 'המילים שלי']);
    expect(bars.map((bar) => bar.spoken)).toEqual(['שיעורי בית ה׳, 1 מתוך 3', 'שיעורי בית ו׳, 2 מתוך 3', 'המילים שלי, 3 מתוך 3']);
  });

  it('leaves two of a kind due on the same weekday alike, told apart by their place', () => {
    const bars = stackBars(['h1', 'h2'], [homework('h1', '2026-10-22'), homework('h2', '2026-10-29')]);
    expect(bars.map((bar) => bar.label)).toEqual(['שיעורי בית ה׳', 'שיעורי בית ה׳']);
    expect(bars.map((bar) => bar.spoken)).toEqual(['שיעורי בית ה׳, 1 מתוך 2', 'שיעורי בית ה׳, 2 מתוך 2']);
  });

  it('turns to the kind\'s icon and the day from five cards, and speaks the full name', () => {
    const soon = summary('t1', 'owed', '2026-10-20', { days_left: 1 });
    const bars = stackBars(
      ['t1', 'h1', 'h2', 'main', 'h3'],
      [soon, homework('h1', '2026-10-22'), homework('h2', '2026-10-23'), homework('h3', '2026-10-30', 12)],
    );
    expect(bars.map((bar) => [bar.icon, bar.label])).toEqual([
      ['exam', 'ג׳'],
      ['homework', 'ה׳'],
      ['homework', 'ו׳'],
      ['main', ''],
      ['homework', 'ו׳'],
    ]);
    expect(bars.map((bar) => bar.spoken)).toEqual([
      'בוחן ג׳, 1 מתוך 5',
      'שיעורי בית ה׳, 2 מתוך 5',
      'שיעורי בית ו׳, 3 מתוך 5',
      'המילים שלי, 4 מתוך 5',
      'שיעורי בית ו׳, 5 מתוך 5',
    ]);
    expect(bars.map((bar) => bar.urgent)).toEqual([true, false, false, false, false]);
  });
});

describe('dotLook (phase 64, spec D5)', () => {
  it('draws the top card long and blue, an urgent card under it amber, and the rest grey', () => {
    expect(dotLook({ onTop: true, urgent: false })).toBe('on');
    expect(dotLook({ onTop: true, urgent: true })).toBe('on');
    expect(dotLook({ onTop: false, urgent: true })).toBe('urgent');
    expect(dotLook({ onTop: false, urgent: false })).toBe('off');
  });
});

// Phase 65 (spec D4, D5). The card: readiness first, today's gain on its bar, today as a budget.
describe('readinessBar (phase 65)', () => {
  const at = (start: number, now: number) => readinessBar(summary('t', 'owed', '2026-10-21', { readiness_start_pct: start, readiness_pct: now }));

  it('shows the gain bright at the end of the start, with its label', () => {
    expect(at(70, 83)).toEqual({ start: 70, gain: 13, label: `${ltr('+13%')} היום` });
  });

  it('has no label before any answer today', () => {
    expect(at(70, 70)).toEqual({ start: 70, gain: 0, label: null });
  });

  it('shows a lower day as a negative gain', () => {
    expect(at(74, 70)).toEqual({ start: 74, gain: -4, label: `${ltr('−4%')} היום` });
  });
});

describe('sessionDots and sessionsLine (phase 65)', () => {
  const today = (state: TodayState, over: Partial<TargetSummary['today']>) => summary('t', state, '2026-10-21', { today: over });

  it('offers the count before the first session, with the minutes', () => {
    const t = today('owed', { sessions_budget: null, sessions_offer: 5, minutes: 25 });
    expect(sessionDots(t)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
    expect(sessionsLine(t)).toEqual({ kind: 'offer', text: `היום: ${ltr('5')} תרגולים`, side: `כ-${ltr('25')} דקות` });
  });

  it('counts the sessions done out of the budget, and what is left', () => {
    const t = today('owed', { sessions_budget: 5, sessions_done: 3 });
    expect(sessionDots(t)).toEqual(['done', 'done', 'done', 'todo', 'todo']);
    expect(sessionsLine(t)).toEqual({ kind: 'progress', text: `היום: ${ltr('3')} מתוך ${ltr('5')} תרגולים`, side: `עוד ${ltr('2')}` });
  });

  it('fades the unused dots when the work ran out, and says so', () => {
    const t = today('done', { sessions_budget: 5, sessions_done: 4, ended_early: true });
    expect(sessionDots(t)).toEqual(['done', 'done', 'done', 'done', 'faded']);
    expect(sessionsLine(t)).toEqual({ kind: 'early', text: 'סיימת להיום ✓', side: `${ltr('4')} במקום ${ltr('5')}` });
  });

  it('is met: all dots done, nothing more to say', () => {
    const t = today('done', { sessions_budget: 5, sessions_done: 5 });
    expect(sessionDots(t)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(sessionsLine(t)).toEqual({ kind: 'met', text: 'סיימת להיום ✓', side: null });
  });

  it('reads a done day as met even when the budget was never set', () => {
    const t = today('done', { sessions_budget: null, sessions_offer: 5, ended_early: false });
    expect(sessionsLine(t)).toEqual({ kind: 'met', text: 'סיימת להיום ✓', side: null });
  });

  it('draws the sessions past the budget as bonus dots', () => {
    const t = today('done', { sessions_budget: 5, sessions_done: 6 });
    expect(sessionDots(t)).toEqual(['done', 'done', 'done', 'done', 'done', 'bonus']);
    expect(sessionsLine(t)).toEqual({ kind: 'met', text: 'סיימת להיום ✓', side: `${ltr('+1')} בונוס` });
  });

  it('shows a rest day only bonus dots, if any practice happened', () => {
    expect(sessionDots(today('rest', { sessions_budget: null, sessions_offer: 0 }))).toEqual([]);
    expect(sessionsLine(today('rest', {}))).toEqual({ kind: 'rest', text: '', side: null });
    const practised = today('rest', { sessions_done: 2 });
    expect(sessionDots(practised)).toEqual(['bonus', 'bonus']);
    expect(sessionsLine(practised)).toEqual({ kind: 'rest', text: '', side: `${ltr('+2')} בונוס` });
  });

  it('says nothing of sessions on the date', () => {
    const t = today('due_today', { sessions_budget: null, sessions_offer: 3 });
    expect(sessionDots(t)).toEqual([]);
    expect(sessionsLine(t)).toEqual({ kind: 'none', text: '', side: null });
  });

  // The dots are hidden from a screen reader: the row says in Hebrew what they draw.
  it("says the row for a screen reader: the offer as written, else the count the dots draw, after the day's end", () => {
    expect(sessionsSpoken(today('owed', { sessions_budget: null, sessions_offer: 5, minutes: 25 }))).toBe(
      `היום: ${ltr('5')} תרגולים, כ-${ltr('25')} דקות`,
    );
    expect(sessionsSpoken(today('owed', { sessions_budget: 5, sessions_done: 3 }))).toBe(`${ltr('3')} מתוך ${ltr('5')} תרגולים היום`);
    expect(sessionsSpoken(today('done', { sessions_budget: 5, sessions_done: 4, ended_early: true }))).toBe(
      `סיימת להיום, ${ltr('4')} מתוך ${ltr('5')} תרגולים היום`,
    );
    expect(sessionsSpoken(today('done', { sessions_budget: 5, sessions_done: 6 }))).toBe(
      `סיימת להיום, ${ltr('5')} מתוך ${ltr('5')} תרגולים היום ועוד ${ltr('1')} בונוס`,
    );
    expect(sessionsSpoken(today('rest', { sessions_done: 2 }))).toBe(`${ltr('+2')} בונוס`);
    expect(sessionsSpoken(today('rest', {}))).toBe('');
  });
});

describe('ready means every word at 90 (phase 65)', () => {
  it('outlines the last review only once every word is ready', () => {
    const almost = summary('a', 'due_today', '2026-10-16', { days_left: 0, ready_count: 7, word_count: 8, readiness_pct: 99 });
    expect(homeOrder([almost]).first).toBe('a');
  });
});

// Phase 65 (spec D6). A tapped word's counted skills: in order, each with its chance out of 100.
describe('skillRows (phase 65)', () => {
  const word = (skills: TargetWord['skills']): TargetWord => ({ ...WORD, skills });

  it('lists the counted skills in order with their names and chances', () => {
    const rows = skillRows(word([
      { dimension: 'written_productive', chance: 82, held: false },
      { dimension: 'spelling', chance: 40, held: false },
      { dimension: 'spoken_productive', chance: 90, held: false },
    ]));
    expect(rows.map((row) => [row.dimension, row.name, row.chance])).toEqual([
      ['written_productive', 'כתיבה', 82],
      ['spelling', 'איות', 40],
      ['spoken_productive', 'דיבור', 90],
    ]);
  });

  it('marks a skill ready from 90, and not at 89', () => {
    const rows = skillRows(word([
      { dimension: 'spelling', chance: 89, held: false },
      { dimension: 'written_productive', chance: 90, held: false },
    ]));
    expect(rows.map((row) => row.ready)).toEqual([false, true]);
  });

  it('says a held skill counts half until tomorrow, and says nothing for the others', () => {
    const rows = skillRows(word([
      { dimension: 'spelling', chance: 30, held: true },
      { dimension: 'written_productive', chance: 60, held: false },
    ]));
    expect(rows.map((row) => row.note)).toEqual(['חצי עד שתענה נכון מחר', null]);
  });

  it('has no rows for a word with no counted skills', () => {
    expect(skillRows(word([]))).toEqual([]);
  });
});

describe('askBeforePracticeMore', () => {
  const target = (state: 'owed' | 'done' | 'rest' | 'due_today', little: boolean): TargetSummary =>
    ({ id: 't1', kind: 'exam', due_on: '2026-10-20', created_on: '2026-10-10', days_left: 5, word_count: 4, ready_count: 1,
      ...DAY, practice_more_little: little, today: { ...DAY.today, state } }) as TargetSummary;

  it('asks only when today is done, another session adds little, and the learner has not opted out', () => {
    expect(askBeforePracticeMore(target('done', true), false)).toBe(true);
    expect(askBeforePracticeMore(target('done', true), true)).toBe(false);
    expect(askBeforePracticeMore(target('done', false), false)).toBe(false);
    expect(askBeforePracticeMore(target('owed', true), false)).toBe(false);
    expect(askBeforePracticeMore(target('due_today', true), false)).toBe(false);
    expect(askBeforePracticeMore(target('rest', true), false)).toBe(false);
  });
});

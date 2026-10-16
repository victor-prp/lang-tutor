import { describe, expect, it } from '@jest/globals';
import type { CurrentSessionResponse, TargetSummary } from '@lang-tutor/core/api';

import {
  createLook,
  currentFor,
  homeActionOf,
  homeReminderStartOf,
  loadFailedFor,
  myWordsLine,
  reminderStartOf,
  shouldAutoCreate,
  shouldPoll,
  targetSessionAction,
} from './nextSession';

const none = (next_source: 'seed' | 'list', saved_count = 0): CurrentSessionResponse => ({
  current: null,
  next_source,
  saved_count,
  due_count: 0,
});
const withCurrent = (
  status: 'preparing' | 'ready' | 'failed',
  answered = 0,
  saved_count = 4,
): CurrentSessionResponse => ({
  current: { session_id: 's1', status, source: 'list', answered, total: status === 'preparing' ? 0 : 4 },
  next_source: 'list',
  saved_count,
  due_count: 0,
});

describe('homeActionOf — the seven home states', () => {
  it.each([
    ['no session yet: start the seed', none('seed'), { kind: 'start-seed' }],
    ['past the seed with saved words: create', none('list', 3), { kind: 'create' }],
    ['past the seed with nothing saved', none('list', 0), { kind: 'save-words-first' }],
    ['preparing', withCurrent('preparing'), { kind: 'preparing', sessionId: 's1' }],
    ['ready and untouched: start', withCurrent('ready', 0), { kind: 'start', sessionId: 's1' }],
    ['ready with answers: resume', withCurrent('ready', 2), { kind: 'resume', sessionId: 's1' }],
    ['failed, with saved words to try again', withCurrent('failed'), { kind: 'failed' }],
    // create would answer 409 no_saved_words and loop silently
    ['failed, with nothing saved', withCurrent('failed', 0, 0), { kind: 'save-words-first' }],
  ])('%s', (_label, state, action) => {
    expect(homeActionOf(state)).toEqual(action);
  });
});

describe('shouldPoll', () => {
  it('polls only while a session is preparing', () => {
    expect(shouldPoll(withCurrent('preparing'))).toBe(true);
    expect(shouldPoll(withCurrent('ready'))).toBe(false);
    expect(shouldPoll(withCurrent('failed'))).toBe(false);
    expect(shouldPoll(none('list', 3))).toBe(false);
    expect(shouldPoll(null)).toBe(false);
  });
});

describe('currentFor', () => {
  const stored = { enrollmentId: 'en', state: none('seed') };

  it('shows the state stored for the active enrollment', () => {
    expect(currentFor(stored, 'en')).toBe(stored.state);
  });
  it('hides a state stored for another enrollment', () => {
    expect(currentFor(stored, 'ru')).toBeNull();
  });
  it('is null with nothing stored, or no active enrollment', () => {
    expect(currentFor(null, 'en')).toBeNull();
    expect(currentFor(stored, undefined)).toBeNull();
  });
});

describe('loadFailedFor', () => {
  const state = none('seed');

  it('is true when the first read for the active enrollment failed and nothing is shown', () => {
    expect(loadFailedFor('en', 'en', null)).toBe(true);
  });
  it('is false for a failure that was about another enrollment', () => {
    expect(loadFailedFor('ru', 'en', null)).toBe(false);
  });
  it('is false once a read is shown, so a failed poll keeps the state it had', () => {
    expect(loadFailedFor('en', 'en', state)).toBe(false);
  });
  it('is false with no failure, or no active enrollment', () => {
    expect(loadFailedFor(null, 'en', null)).toBe(false);
    expect(loadFailedFor('en', undefined, null)).toBe(false);
  });
});

// Phase 43 (spec D7). Home makes a missing session itself, once per focus and
// enrollment, and offers a retry only after that create failed.
describe('shouldAutoCreate', () => {
  it('sends create for the create state, once per enrollment', () => {
    expect(shouldAutoCreate({ kind: 'create' }, null, 'e1')).toBe(true);
    expect(shouldAutoCreate({ kind: 'create' }, 'e1', 'e1')).toBe(false);
    expect(shouldAutoCreate({ kind: 'create' }, 'e2', 'e1')).toBe(true);
  });

  it('sends nothing for any other state', () => {
    expect(shouldAutoCreate({ kind: 'start', sessionId: 's1' }, null, 'e1')).toBe(false);
    expect(shouldAutoCreate({ kind: 'failed' }, null, 'e1')).toBe(false);
    expect(shouldAutoCreate({ kind: 'save-words-first' }, null, 'e1')).toBe(false);
    expect(shouldAutoCreate(null, null, 'e1')).toBe(false);
  });
});

describe('createLook', () => {
  it('shows preparing while the create runs or has not failed', () => {
    expect(createLook(null, 'e1')).toBe('preparing');
    expect(createLook('e2', 'e1')).toBe('preparing');
  });

  it('offers a retry once the create for this enrollment failed, never a second create of its own', () => {
    expect(createLook('e1', 'e1')).toBe('retry');
  });
});

// Phase 52 (spec D8). A tapped reminder opens home with start=reminder, and home
// starts or resumes the ready session once, as its own button would, on a read
// made after the tap: the one home held when the tap came can be about a
// session finished since (a target of two, the first just done).
describe('reminderStartOf', () => {
  const fresh = { failed: false, read: true };
  const stale = { failed: false, read: false };

  it('enters a session that is ready, untouched or with answers', () => {
    expect(reminderStartOf({ kind: 'start', sessionId: 's1' }, fresh)).toEqual({
      kind: 'enter',
      sessionId: 's1',
      fresh: true,
    });
    // The same two arguments the start button's own handler gets (fresh is `kind === 'start'`).
    expect(reminderStartOf({ kind: 'resume', sessionId: 's1' }, fresh)).toEqual({
      kind: 'enter',
      sessionId: 's1',
      fresh: false,
    });
  });

  it('waits for a read made after the tap, whatever the held one says', () => {
    expect(reminderStartOf({ kind: 'start', sessionId: 's1' }, stale)).toEqual({ kind: 'wait' });
    expect(reminderStartOf({ kind: 'resume', sessionId: 's1' }, stale)).toEqual({ kind: 'wait' });
    // Nor does a held state with nothing to start clear the param before the new read says so.
    expect(reminderStartOf({ kind: 'start-seed' }, stale)).toEqual({ kind: 'wait' });
    expect(reminderStartOf({ kind: 'save-words-first' }, stale)).toEqual({ kind: 'wait' });
    expect(reminderStartOf({ kind: 'failed' }, stale)).toEqual({ kind: 'wait' });
    expect(reminderStartOf({ kind: 'create' }, stale)).toEqual({ kind: 'wait' });
    expect(reminderStartOf({ kind: 'preparing', sessionId: 's1' }, stale)).toEqual({ kind: 'wait' });
  });

  it('waits while home has not read the session, or the session is being made', () => {
    expect(reminderStartOf(null, fresh)).toEqual({ kind: 'wait' });
    expect(reminderStartOf(null, stale)).toEqual({ kind: 'wait' });
    expect(reminderStartOf({ kind: 'preparing', sessionId: 's1' }, fresh)).toEqual({ kind: 'wait' });
    expect(reminderStartOf({ kind: 'create' }, fresh)).toEqual({ kind: 'wait' });
  });

  it('gives up when what it waits for failed, so a late recovery does not start a session unasked', () => {
    expect(reminderStartOf(null, { failed: true, read: false })).toEqual({ kind: 'clear' });
    expect(reminderStartOf({ kind: 'create' }, { failed: true, read: true })).toEqual({ kind: 'clear' });
  });

  it('clears when the new read has nothing ready to start', () => {
    expect(reminderStartOf({ kind: 'start-seed' }, fresh)).toEqual({ kind: 'clear' });
    expect(reminderStartOf({ kind: 'save-words-first' }, fresh)).toEqual({ kind: 'clear' });
    expect(reminderStartOf({ kind: 'failed' }, fresh)).toEqual({ kind: 'clear' });
  });
});

// Phase 57 (spec D1, D11). A target's card offers its own path's session, read from the
// target's `session` as homeActionOf reads `current`; with none, the card creates one.
const targetWith = (session: CurrentSessionResponse['current']): TargetSummary => ({
  id: 't1',
  kind: 'exam',
  due_on: '2026-10-21',
  days_left: 5,
  word_count: 8,
  ready_count: 0,
  readiness_pct: 18,
  today: { state: 'owed', done: 0, planned: 8, extra: 0, next_practice_in: null },
  session,
});
const session = (status: 'preparing' | 'ready' | 'failed' | 'completed', answered = 0) => ({
  session_id: 'ts1',
  status,
  source: 'list' as const,
  answered,
  total: status === 'preparing' ? 0 : 4,
});

describe('targetSessionAction', () => {
  it.each([
    ['no session: create one with the target', null, { kind: 'create' }],
    ['preparing', session('preparing'), { kind: 'preparing', sessionId: 'ts1' }],
    ['ready and untouched: start', session('ready', 0), { kind: 'start', sessionId: 'ts1' }],
    ['ready with answers: resume', session('ready', 3), { kind: 'resume', sessionId: 'ts1' }],
    // Every target has words, so a failed one is always offered again.
    ['failed: try again', session('failed'), { kind: 'failed' }],
    ['a finished session is not offered: create', session('completed', 4), { kind: 'create' }],
  ])('%s', (_label, current, action) => {
    expect(targetSessionAction(targetWith(current))).toEqual(action);
  });
});

// Phase 57 (spec D2, D11). A reminder opens the path of home's first card: a target's, once
// the targets read after the tap is in, else the main path's as phase 52 does.
describe('homeReminderStartOf', () => {
  const fresh = { failed: false, read: true };
  const stale = { failed: false, read: false };
  const owed = (current: CurrentSessionResponse['current']) => [targetWith(current)];
  const done = (current: CurrentSessionResponse['current']): TargetSummary[] => [
    { ...targetWith(current), today: { state: 'done', done: 8, planned: 8, extra: 0, next_practice_in: null } },
  ];
  const mainReady = { kind: 'start', sessionId: 'm1' } as const;

  it('waits for the targets read made after the tap, whatever the main path holds', () => {
    expect(homeReminderStartOf('reading', mainReady, fresh)).toEqual({ kind: 'wait' });
  });

  it('gives up when that read failed: home cannot tell which card is first', () => {
    expect(homeReminderStartOf('failed', mainReady, fresh)).toEqual({ kind: 'clear' });
  });

  it("enters the first target's session when it is ready, as its card's button does", () => {
    expect(homeReminderStartOf(owed(session('ready', 0)), mainReady, stale)).toEqual({
      kind: 'enter',
      sessionId: 'ts1',
      fresh: true,
    });
    expect(homeReminderStartOf(owed(session('ready', 2)), null, stale)).toEqual({
      kind: 'enter',
      sessionId: 'ts1',
      fresh: false,
    });
  });

  it('clears when the first target has nothing ready to enter', () => {
    expect(homeReminderStartOf(owed(null), mainReady, fresh)).toEqual({ kind: 'clear' });
    expect(homeReminderStartOf(owed(session('preparing')), mainReady, fresh)).toEqual({ kind: 'clear' });
    expect(homeReminderStartOf(owed(session('failed')), mainReady, fresh)).toEqual({ kind: 'clear' });
  });

  it("follows the main path's phase 52 rules when My words is first", () => {
    expect(homeReminderStartOf([], mainReady, fresh)).toEqual({ kind: 'enter', sessionId: 'm1', fresh: true });
    expect(homeReminderStartOf([], mainReady, stale)).toEqual({ kind: 'wait' });
    expect(homeReminderStartOf([], null, { failed: true, read: false })).toEqual({ kind: 'clear' });
    // A target done for today sits below My words: the reminder opens My words.
    expect(homeReminderStartOf(done(session('ready')), mainReady, fresh)).toEqual({
      kind: 'enter',
      sessionId: 'm1',
      fresh: true,
    });
  });
});

describe('myWordsLine', () => {
  const ltr = (text: string) => `⁦${text}⁩`;

  it('counts the words waiting for review', () => {
    expect(myWordsLine({ ...none('list', 30), due_count: 12 }, 'איטלקית')).toBe(`${ltr('12')} מילים מחכות לחזרה`);
  });

  it('counts the saved meanings when none waits', () => {
    expect(myWordsLine(none('list', 30), 'איטלקית')).toBe('30 משמעויות שמורות באיטלקית');
  });

  it("names the seed's words before the first session", () => {
    expect(myWordsLine(none('seed'), 'איטלקית')).toBe('10 מילים באיטלקית');
  });
});

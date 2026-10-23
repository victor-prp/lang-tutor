import { describe, expect, it } from '@jest/globals';
import type { CurrentSessionResponse, TargetSummary } from '@lang-tutor/core/api';

import {
  createLook,
  currentFor,
  homeActionOf,
  homeReminderStartOf,
  loadFailedFor,
  mainButtonSolid,
  mainEmptyNote,
  myWordsBand,
  myWordsLine,
  openSessionOf,
  reminderStartOf,
  shouldAutoCreate,
  shouldPoll,
  targetPress,
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
  current: { session_id: 's1', status, source: 'list', answered, total: status === 'preparing' ? 0 : 4, started: answered > 0 },
  next_source: 'list',
  saved_count,
  due_count: 0,
});

describe('homeActionOf — the seven home states', () => {
  it.each([
    ['no session yet, nothing saved: Words for me', none('seed'), { kind: 'discover' }],
    ['past the seed with saved words: create', none('list', 3), { kind: 'create' }],
    ['past the seed with nothing saved', none('list', 0), { kind: 'discover' }],
    ['preparing', withCurrent('preparing'), { kind: 'preparing', sessionId: 's1' }],
    ['ready and untouched: start', withCurrent('ready', 0), { kind: 'start', sessionId: 's1' }],
    ['ready with answers: resume', withCurrent('ready', 2), { kind: 'resume', sessionId: 's1' }],
    ['failed, with saved words to try again', withCurrent('failed'), { kind: 'failed' }],
    // create would answer 409 no_saved_words and loop silently
    ['failed, with nothing saved', withCurrent('failed', 0, 0), { kind: 'discover' }],
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
    expect(shouldAutoCreate({ kind: 'discover' }, null, 'e1')).toBe(false);
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
    expect(reminderStartOf({ kind: 'discover' }, stale)).toEqual({ kind: 'wait' });
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
    expect(reminderStartOf({ kind: 'discover' }, fresh)).toEqual({ kind: 'clear' });
    expect(reminderStartOf({ kind: 'failed' }, fresh)).toEqual({ kind: 'clear' });
  });
});

// Phase 57 (spec D1, D11). A target's card offers its own path's session, read from the
// target's `session` as homeActionOf reads `current`; with none, the card creates one.
const targetWith = (session: CurrentSessionResponse['current']): TargetSummary => ({
  id: 't1',
  kind: 'exam',
  due_on: '2026-10-21',
  created_on: '2026-10-11',
  days_left: 5,
  word_count: 8,
  ready_count: 0,
  readiness_pct: 18,
  readiness_start_pct: 18,
  practice_more_little: false,
  word_readiness: [],
  today: { state: 'owed', done: 0, planned: 8, extra: 0, next_practice_in: null, sessions_budget: null, sessions_offer: 0, sessions_done: 0, ended_early: false, minutes: 0 },
  session,
});
const session = (status: 'preparing' | 'ready' | 'failed' | 'completed', answered = 0, started = answered > 0) => ({
  session_id: 'ts1',
  status,
  source: 'list' as const,
  answered,
  total: status === 'preparing' ? 0 : 4,
  started,
});

describe('targetSessionAction', () => {
  it.each([
    ['no session: create one with the target', null, { kind: 'create' }],
    ['preparing', session('preparing'), { kind: 'preparing', sessionId: 'ts1' }],
    ['ready and untouched: start', session('ready', 0), { kind: 'start', sessionId: 'ts1' }],
    ['ready with answers: resume', session('ready', 3), { kind: 'resume', sessionId: 'ts1' }],
    // Final review N1. Entered and left before any answer: started, so resumed, never created.
    ['started with no answer: resume', session('ready', 0, true), { kind: 'resume', sessionId: 'ts1' }],
    // Every target has words, so a failed one is always offered again.
    ['failed: try again', session('failed'), { kind: 'failed' }],
    ['a finished session is not offered: create', session('completed', 4), { kind: 'create' }],
  ])('%s', (_label, current, action) => {
    expect(targetSessionAction(targetWith(current))).toEqual(action);
  });
});

// Phase 57 (spec D1, final review C1). A target's button: a started session is resumed as it
// is; an unstarted one, none, or a failed one goes through create, which answers the path's stock
// (replaced when it no longer serves the day) or builds one; a preparing one does nothing.
// Final review N1. After a create refused with session_open, the path's session in a list read
// since: the one to enter, if it is ready.
describe('openSessionOf', () => {
  it("answers the target's ready session, started or not", () => {
    expect(openSessionOf([targetWith(session('ready', 0, true))], 't1')).toBe('ts1');
    expect(openSessionOf([targetWith(session('ready', 2))], 't1')).toBe('ts1');
  });

  it('answers none for a session not ready, another target, or no list', () => {
    expect(openSessionOf([targetWith(session('preparing'))], 't1')).toBeNull();
    expect(openSessionOf([targetWith(session('ready', 0, true))], 't2')).toBeNull();
    expect(openSessionOf(null, 't1')).toBeNull();
  });
});

describe('targetPress', () => {
  it.each([
    ['resumes a started session as it is', session('ready', 3), { kind: 'enter', sessionId: 'ts1', fresh: false }],
    ['resumes one started with no answer, with no create (final review N1)', session('ready', 0, true), { kind: 'enter', sessionId: 'ts1', fresh: false }],
    // The stock is answered or replaced for the devices it was built for: no wait on the voices.
    ['sends an unstarted stock through create', session('ready', 0), { kind: 'create', waitForVoices: false }],
    ['creates with no session, for this device', null, { kind: 'create', waitForVoices: true }],
    ['creates again after a failure, for this device', session('failed'), { kind: 'create', waitForVoices: true }],
    ['does nothing while one prepares', session('preparing'), { kind: 'none' }],
  ])('%s', (_label, current, press) => {
    expect(targetPress(targetSessionAction(targetWith(current)))).toEqual(press);
  });
});

// Phase 57 (spec D2, D11). A reminder opens the path of home's first card, judged on the targets
// read made after the tap, held as it landed (final review CI-1): never on a list home rendered
// before it. A target first goes through create, as its button does (final review C1), and is
// waited for while it prepares; it never falls to My words. My words first follows phase 52.
describe('homeReminderStartOf', () => {
  const fresh = { failed: false, read: true };
  const stale = { failed: false, read: false };
  const owed = (current: CurrentSessionResponse['current']) => [targetWith(current)];
  const done = (current: CurrentSessionResponse['current']): TargetSummary[] => [
    { ...targetWith(current), today: { ...targetWith(current).today, state: 'done', done: 8 } },
  ];
  const mainReady = { kind: 'start', sessionId: 'm1' } as const;
  const answered = (status: 'ready' | 'preparing', sessionId = 'ts2') => ({ kind: 'answered', sessionId, status }) as const;

  it('waits for the targets read made after the tap, whatever the main path holds', () => {
    expect(homeReminderStartOf('reading', mainReady, fresh)).toEqual({ kind: 'wait' });
  });

  it('gives up when that read failed: home cannot tell which card is first', () => {
    expect(homeReminderStartOf('failed', mainReady, fresh)).toEqual({ kind: 'clear' });
  });

  it("sends create for the first target's unstarted session, preparing one or none, as its button does", () => {
    for (const current of [session('ready', 0), session('preparing')]) {
      expect(homeReminderStartOf(owed(current), mainReady, fresh)).toEqual({ kind: 'create', targetId: 't1', waitForVoices: false });
    }
    expect(homeReminderStartOf(owed(null), mainReady, fresh)).toEqual({ kind: 'create', targetId: 't1', waitForVoices: true });
  });

  // CI run 38964276019: home's list from before the read landed showed no target, and the
  // reminder entered My words while the homework owed work.
  it('judges on the held read, never on the list home shows: a target first is never left for My words', () => {
    expect(homeReminderStartOf(owed(session('ready', 0)), mainReady, fresh, { kind: 'none' }, [])).toEqual({
      kind: 'create',
      targetId: 't1',
      waitForVoices: false,
    });
    expect(homeReminderStartOf(owed(session('ready', 0)), mainReady, fresh, answered('preparing'), [])).toEqual({ kind: 'wait' });
  });

  it('waits while its create is out, and enters what create answers ready', () => {
    expect(homeReminderStartOf(owed(session('ready', 0)), mainReady, fresh, { kind: 'sending' })).toEqual({ kind: 'wait' });
    expect(homeReminderStartOf(owed(session('ready', 0)), mainReady, fresh, answered('ready', 'ts1'))).toEqual({
      kind: 'enter',
      sessionId: 'ts1',
      fresh: true,
    });
  });

  it('waits while the session create answered prepares, and enters it once a later read shows it ready', () => {
    const replaced = (status: 'preparing' | 'ready' | 'failed', sessionId = 'ts2') => [targetWith({ ...session(status), session_id: sessionId })];
    const held = owed(session('ready', 0));
    expect(homeReminderStartOf(held, mainReady, fresh, answered('preparing'), replaced('preparing'))).toEqual({ kind: 'wait' });
    expect(homeReminderStartOf(held, mainReady, fresh, answered('preparing'), replaced('ready'))).toEqual({
      kind: 'enter',
      sessionId: 'ts2',
      fresh: true,
    });
    // A render from before create's read still shows the stock it replaced: wait, never clear.
    expect(homeReminderStartOf(held, mainReady, fresh, answered('preparing'), replaced('ready', 'ts1'))).toEqual({ kind: 'wait' });
    expect(homeReminderStartOf(held, mainReady, fresh, answered('preparing'), replaced('failed'))).toEqual({ kind: 'clear' });
  });

  it("resumes the first target's started session as it is, with no create", () => {
    expect(homeReminderStartOf(owed(session('ready', 2)), null, stale)).toEqual({ kind: 'enter', sessionId: 'ts1', fresh: false });
    // Final review N1: started and left before any answer.
    expect(homeReminderStartOf(owed(session('ready', 0, true)), null, stale)).toEqual({ kind: 'enter', sessionId: 'ts1', fresh: false });
  });

  // Final review N1. Create refused with session_open: the path has a started session after all
  // (a list read before it was started); the reminder enters it, as it was, read again.
  it('enters the started session a refused create points to', () => {
    expect(homeReminderStartOf(owed(session('ready', 0)), mainReady, fresh, { kind: 'open', sessionId: 'ts9' })).toEqual({
      kind: 'enter',
      sessionId: 'ts9',
      fresh: false,
    });
  });

  it('clears when the first target failed, or its create did', () => {
    expect(homeReminderStartOf(owed(session('failed')), mainReady, fresh)).toEqual({ kind: 'clear' });
    expect(homeReminderStartOf(owed(null), mainReady, fresh, { kind: 'failed' })).toEqual({ kind: 'clear' });
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

// Final review M2. My words with nothing of its own: every saved word is in an active target,
// which practises it; or nothing is saved at all.
describe('mainEmptyNote', () => {
  const summary = (kind: 'exam' | 'homework', word_count: number): TargetSummary => ({ ...targetWith(null), kind, word_count });

  it('asks to save words first when no target holds a word', () => {
    expect(mainEmptyNote(null)).toEqual({ kind: 'save-words-first', text: 'כדי לתרגל, שמרו קודם מילים במסך התרגום.' });
    expect(mainEmptyNote([])).toEqual({ kind: 'save-words-first', text: 'כדי לתרגל, שמרו קודם מילים במסך התרגום.' });
    expect(mainEmptyNote([summary('exam', 0)]).kind).toBe('save-words-first');
  });

  it('says the words are all in the targets, by their kinds', () => {
    expect(mainEmptyNote([summary('exam', 3)])).toEqual({ kind: 'all-in-targets', text: 'כל המילים שלך כבר בהכנה לבוחן.' });
    expect(mainEmptyNote([summary('homework', 3), summary('homework', 2)]).text).toBe('כל המילים שלך כבר בהכנה לשיעורי הבית.');
    expect(mainEmptyNote([summary('homework', 3), summary('exam', 1)]).text).toBe('כל המילים שלך כבר בהכנה לבוחן ולשיעורי הבית.');
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

  it('counts the saved meanings in a seed state too (no seed branch)', () => {
    expect(myWordsLine(none('seed', 0), 'איטלקית')).toBe('0 משמעויות שמורות באיטלקית');
  });
});

// Phase 64 (spec D4). My words' blue header and its button's look.
describe('mainButtonSolid (phase 64, spec D4)', () => {
  it('is solid whenever the button starts or resumes a session', () => {
        expect(mainButtonSolid({ kind: 'start', sessionId: 's1' })).toBe(true);
    expect(mainButtonSolid({ kind: 'resume', sessionId: 's1' })).toBe(true);
  });

  it('is pale while preparing, creating, failed, empty or unread', () => {
    expect(mainButtonSolid({ kind: 'preparing', sessionId: 's1' })).toBe(false);
    expect(mainButtonSolid({ kind: 'create' })).toBe(false);
    expect(mainButtonSolid({ kind: 'failed' })).toBe(false);
    expect(mainButtonSolid({ kind: 'discover' })).toBe(false);
    expect(mainButtonSolid(null)).toBe(false);
  });
});

describe('myWordsBand (phase 64, spec D4)', () => {
  const ltr = (text: string) => `\u2066${text}\u2069`;

  it('counts the saved meanings in a seed state (no seed branch)', () => {
    expect(myWordsBand(none('seed', 0), 'איטלקית')).toEqual({ big: ltr('0'), line: 'משמעויות שמורות באיטלקית' });
  });

  it('counts the words due for review', () => {
    expect(myWordsBand({ ...none('list', 64), due_count: 12 }, 'איטלקית')).toEqual({ big: ltr('12'), line: 'מילים מחכות לחזרה' });
    expect(myWordsBand({ ...none('list', 64), due_count: 1 }, 'איטלקית')).toEqual({ big: ltr('1'), line: 'מילה מחכה לחזרה' });
  });

  it('counts the meanings saved when none is due', () => {
    expect(myWordsBand(none('list', 64), 'איטלקית')).toEqual({ big: ltr('64'), line: 'משמעויות שמורות באיטלקית' });
  });
});

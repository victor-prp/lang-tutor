import { describe, expect, it } from '@jest/globals';
import type { CurrentSessionResponse } from '@lang-tutor/core/api';

import { createLook, currentFor, homeActionOf, loadFailedFor, shouldAutoCreate, shouldPoll } from './nextSession';

const none = (next_source: 'seed' | 'list', saved_count = 0): CurrentSessionResponse => ({
  current: null,
  next_source,
  saved_count,
});
const withCurrent = (
  status: 'preparing' | 'ready' | 'failed',
  answered = 0,
  saved_count = 4,
): CurrentSessionResponse => ({
  current: { session_id: 's1', status, source: 'list', answered, total: status === 'preparing' ? 0 : 4 },
  next_source: 'list',
  saved_count,
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

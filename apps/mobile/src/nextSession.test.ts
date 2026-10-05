import { describe, expect, it } from '@jest/globals';
import type { CurrentSessionResponse } from '@lang-tutor/core/api';

import { homeActionOf, shouldPoll } from './nextSession';

const none = (next_source: 'seed' | 'list', saved_count = 0): CurrentSessionResponse => ({
  current: null,
  next_source,
  saved_count,
});
const withCurrent = (status: 'preparing' | 'ready' | 'failed', answered = 0): CurrentSessionResponse => ({
  current: { session_id: 's1', status, source: 'list', answered, total: status === 'preparing' ? 0 : 4 },
  next_source: 'list',
  saved_count: 4,
});

describe('homeActionOf — the seven home states', () => {
  it.each([
    ['no session yet: start the seed', none('seed'), { kind: 'start-seed' }],
    ['past the seed with saved words: create', none('list', 3), { kind: 'create' }],
    ['past the seed with nothing saved', none('list', 0), { kind: 'save-words-first' }],
    ['preparing', withCurrent('preparing'), { kind: 'preparing', sessionId: 's1' }],
    ['ready and untouched: start', withCurrent('ready', 0), { kind: 'start', sessionId: 's1' }],
    ['ready with answers: resume', withCurrent('ready', 2), { kind: 'resume', sessionId: 's1' }],
    ['failed', withCurrent('failed'), { kind: 'failed' }],
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

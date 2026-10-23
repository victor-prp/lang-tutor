import { describe, expect, it } from '@jest/globals';

import { afterSave, waitStep } from '@/discoverAfterSave';

describe('afterSave', () => {
  it.each([
    ['my-words', 'ready', 'open'],
    ['my-words', 'preparing', 'wait'],
    ['my-words', 'error', 'home'],
    [undefined, 'ready', 'home'],
    ['other', 'preparing', 'home'],
    [undefined, 'error', 'home'],
  ] as [string | undefined, 'ready' | 'preparing' | 'error', string][])('from %s, %s -> %s', (from, outcome, expected) => {
    expect(afterSave(from, outcome)).toBe(expected);
  });
});

describe('waitStep', () => {
  it.each([
    [{ session_id: 's1', status: 'ready' }, 'open'],
    [{ session_id: 's1', status: 'preparing' }, 'wait'],
    [{ session_id: 's1', status: 'failed' }, 'home'],
    [{ session_id: 's2', status: 'ready' }, 'wait'],
    [null, 'wait'],
  ] as [{ session_id: string; status: string } | null, string][])('%j -> %s', (current, expected) => {
    expect(waitStep(current, 's1')).toBe(expected);
  });
});

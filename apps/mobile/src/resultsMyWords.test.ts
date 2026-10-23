import { describe, expect, it } from '@jest/globals';

import type { HomeAction } from '@/nextSession';
import { myWordsContinue, resultsScreenOf } from '@/resultsMyWords';

describe('resultsScreenOf — which results screen a finished session gets', () => {
  it.each<[string | null, 'seed' | 'list' | null, 'practice' | 'question_types' | undefined, string]>([
    [null, 'list', 'practice', 'my-words'],
    [null, 'list', undefined, 'my-words'],
    [null, 'list', 'question_types', 'plain'],
    [null, 'seed', 'practice', 'plain'],
    [null, null, undefined, 'plain'],
    ['t1', 'list', 'practice', 'target'],
    ['t1', 'list', undefined, 'target'],
  ])('target %s, source %s, kind %s -> %s', (targetId, source, kind, screen) => {
    expect(resultsScreenOf({ targetId, source, kind })).toBe(screen);
  });
});

describe('myWordsContinue — the continue button per read and action', () => {
  it.each<['reading' | 'landed' | 'failed', HomeAction | null, string]>([
    ['reading', null, 'waiting'],
    ['failed', null, 'retry-read'],
    ['reading', { kind: 'start', sessionId: 's' }, 'waiting'],
    ['landed', null, 'waiting'],
    ['landed', { kind: 'start', sessionId: 's' }, 'open'],
    ['landed', { kind: 'resume', sessionId: 's' }, 'open'],
    ['landed', { kind: 'create' }, 'open'],
    ['landed', { kind: 'preparing', sessionId: 's' }, 'preparing'],
    ['landed', { kind: 'failed' }, 'retry'],
    ['landed', { kind: 'discover' }, 'home'],
  ])('%s, %j -> %s', (read, action, state) => {
    expect(myWordsContinue(read, action)).toBe(state);
  });
});

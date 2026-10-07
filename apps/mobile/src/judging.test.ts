import { describe, expect, it } from '@jest/globals';
import type { JudgedAnswerResponse } from '@lang-tutor/core/api';

import { canJudge, judgedAnswer } from './judging';

describe('canJudge (phase 27 D13)', () => {
  it('allows an unanswered card that is not being checked, failed or not', () => {
    expect(canJudge('idle', false)).toBe(true);
    expect(canJudge('failed', false)).toBe(true);
  });
  it('refuses while checking, and once answered', () => {
    expect(canJudge('checking', false)).toBe(false);
    expect(canJudge('idle', true)).toBe(false);
  });
});

describe('judgedAnswer', () => {
  it('carries the text and the server verdict', () => {
    const next = { complete: true } as unknown as JudgedAnswerResponse['next'];
    expect(judgedAnswer('לשריין', { verdict: 'exact', next })).toEqual({ text: 'לשריין', judged: 'exact' });
  });
});

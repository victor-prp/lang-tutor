import { describe, expect, it } from '@jest/globals';

import { applyQueued, type QuizState } from './quiz';
import { IDLE_ATTEMPT } from './speaking';

const BASE: QuizState = {
  sessionId: 's',
  question: undefined,
  position: 10,
  total: 10,
  answer: { pass: 'skip' },
  complete: false,
  correctCount: 0,
  missedQuestions: [],
  progress: [],
  queued: null,
  advanceRequested: true,
  speech: IDLE_ATTEMPT,
  speakingOff: 'chosen',
  judging: 'failed',
};

describe('applyQueued (spec D9, Review Focus 3)', () => {
  it('a completion takes the score total, which leaves a skipped card out', () => {
    const done = applyQueued(BASE, {
      complete: true,
      score: { correct: 9, total: 9 },
      missedQuestions: [],
      progress: [],
    });
    expect(done).toMatchObject({ complete: true, correctCount: 9, total: 9 });
  });

  it('a new card starts with no judging in flight or failed (phase 27 D13)', () => {
    const q = { id: 'm', type: 'typed_meaning', vocab_term_id: 'l', question: 'x', part_of_speech: 'verb', meaning: 'y' } as const;
    expect(applyQueued(BASE, { complete: false, question: q, position: 2 }).judging).toBe('idle');
  });
});

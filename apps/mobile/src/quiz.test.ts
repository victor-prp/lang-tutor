import { describe, expect, it } from '@jest/globals';
import type { NextStepResponse, Question, SessionView } from '@lang-tutor/core/api';

import { applyQueued, holds, passFor, queuedFrom, resumed, retried, type QuizState } from './quiz';
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
  retry: null,
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
    const q = { id: 'm', type: 'typed_meaning', vocab_term_id: 'l', question: 'x', part_of_speech: 'verb', meaning: 'y', context: null } as const;
    expect(applyQueued(BASE, { complete: false, question: q, position: 2, retry: null }).judging).toBe('idle');
  });
});

describe('the second try (phase 34 D9)', () => {
  const TYPED: Question = {
    id: 't1',
    type: 'typed_translation',
    vocab_term_id: 'l',
    question: 'חלון',
    part_of_speech: 'noun',
    answer: 'finestra',
    lemma: 'finestra',
    alternatives: ['vetrata'],
    context: null,
  };
  const NEXT: Question = { ...TYPED, id: 't2', question: 'דלת', answer: 'porta', lemma: 'porta', alternatives: [] };
  const PENDING = { answer: 'vetrata', wording: 'word' } as const;
  const response = (question: Question, pending: typeof PENDING | null): NextStepResponse => ({
    session_id: 's',
    question,
    position: { position: 3, total: 10 },
    complete: false,
    pending_retry: pending,
  });
  const ON_CARD: QuizState = { ...BASE, question: TYPED, position: 3, answer: null, advanceRequested: false, speakingOff: null, judging: 'checking' };

  it('a response that holds the card carries its pending answer, and holds', () => {
    const queued = queuedFrom(response(TYPED, PENDING));
    expect(queued).toEqual({ complete: false, question: TYPED, position: 3, retry: PENDING });
    expect(holds(queued)).toBe(true);
  });

  it('a response that moves on does not hold, nor does a completion', () => {
    expect(holds(queuedFrom(response(NEXT, null)))).toBe(false);
    expect(holds({ complete: true, score: { correct: 1, total: 1 }, missedQuestions: [], progress: [] })).toBe(false);
  });

  it('holding opens the same card again for its second try, with nothing in flight', () => {
    const held = applyQueued(ON_CARD, queuedFrom(response(TYPED, PENDING)));
    expect(held).toMatchObject({ question: TYPED, position: 3, answer: null, queued: null, judging: 'idle', retry: PENDING });
    expect(held.speech).toEqual(IDLE_ATTEMPT);
  });

  it('the card after a second try has none', () => {
    const answered: QuizState = { ...ON_CARD, judging: 'idle', retry: PENDING, answer: { text: 'finestra' } };
    expect(applyQueued(answered, queuedFrom(response(NEXT, null)))).toMatchObject({ question: NEXT, retry: null, answer: null });
    const done = applyQueued(answered, { complete: true, score: { correct: 1, total: 1 }, missedQuestions: [], progress: [] });
    expect(done.retry).toBeNull();
  });

  it('a resumed session whose card is pending opens its second try', () => {
    const view: SessionView = {
      session_id: 's',
      status: 'ready',
      source: 'list',
      position: { position: 4, total: 10 },
      question: TYPED,
      pending_retry: PENDING,
      progress: [],
    };
    expect(resumed({ ...BASE, answer: null }, view)).toMatchObject({ question: TYPED, position: 4, total: 10, retry: PENDING, answer: null });
    expect(resumed({ ...BASE, answer: null }, { ...view, pending_retry: null }).retry).toBeNull();
  });

  it('the first answer goes without retry, the second with retry: true', () => {
    expect(retried({ question_id: 't1', text: 'vetrata' }, null)).toEqual({ question_id: 't1', text: 'vetrata' });
    expect(retried({ question_id: 't1', text: 'finestra' }, PENDING)).toEqual({ question_id: 't1', text: 'finestra', retry: true });
    // Show the answer on a typed or judged card: empty text, with retry.
    expect(retried({ question_id: 't1', text: '' }, PENDING)).toEqual({ question_id: 't1', text: '', retry: true });
    expect(retried({ question_id: 't1', mime_type: 'audio/aac', audio: 'AAA' }, PENDING)).toEqual({
      question_id: 't1',
      mime_type: 'audio/aac',
      audio: 'AAA',
      retry: true,
    });
  });

  it('a pass on the second try is the give-up: D9 has no skip there', () => {
    expect(passFor('skip', null)).toBe('skip');
    expect(passFor('show_answer', null)).toBe('show_answer');
    expect(passFor('skip', PENDING)).toBe('show_answer');
    expect(passFor('show_answer', PENDING)).toBe('show_answer');
  });
});

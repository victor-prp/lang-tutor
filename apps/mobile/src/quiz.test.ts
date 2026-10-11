import { describe, expect, it } from '@jest/globals';
import type { NextStepResponse, PendingRetry, Question, SessionView } from '@lang-tutor/core/api';

import type { CardAnswer } from './feedback';
import { answerRoute, applyQueued, holds, landed, metHold, nextStepRequest, passFor, queuedFrom, resumed, retried, settle, type QuizState, type Sent } from './quiz';
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

  describe('landing a response', () => {
    it('a hold opens the second try at once: no banner, nothing queued', () => {
      expect(landed(ON_CARD, { text: 'vetrata' }, response(TYPED, PENDING), null)).toMatchObject({
        question: TYPED,
        answer: null,
        queued: null,
        judging: 'idle',
        retry: PENDING,
      });
    });

    it('anything else answers the card and queues what is next', () => {
      const answered = landed(ON_CARD, { text: 'finestra' }, response(NEXT, null), null);
      expect(answered).toMatchObject({ question: TYPED, answer: { text: 'finestra' }, judging: 'idle', retry: null });
      expect(answered.queued).toEqual({ complete: false, question: NEXT, position: 3, retry: null });
      expect(answered.speech).toEqual(IDLE_ATTEMPT);
    });

    it('a hold this answer met and resolved leaves the card on its second try, for the banner', () => {
      expect(landed(ON_CARD, { text: '' }, response(NEXT, null), PENDING)).toMatchObject({ answer: { text: '' }, retry: PENDING });
    });

    it('a second try keeps the hold it answered, for the banner', () => {
      expect(landed({ ...ON_CARD, retry: PENDING }, { text: 'porta' }, response(NEXT, null), null).retry).toEqual(PENDING);
    });
  });

  describe('how a typed answer goes out', () => {
    const FIRST = { retry: null, judging: 'idle' } as const;

    it('another accepted word waits for the server, so its banner cannot name the saved word', () => {
      expect(answerRoute(FIRST, TYPED, { text: 'vetrata' })).toBe('server');
    });

    it('every other first answer shows its banner at once', () => {
      for (const text of ['finestra', 'finestar', 'porta', '']) expect(answerRoute(FIRST, TYPED, { text })).toBe('banner');
    });

    it('a second try shows its banner at once, even another accepted word', () => {
      expect(answerRoute({ retry: PENDING, judging: 'idle' }, TYPED, { text: 'vetrata' })).toBe('banner');
      expect(answerRoute({ retry: PENDING, judging: 'idle' }, TYPED, { text: '' })).toBe('banner');
    });

    it('after a failed check, show the answer waits for the server, which may hold a first answer already', () => {
      expect(answerRoute({ retry: null, judging: 'failed' }, TYPED, { text: '' })).toBe('server');
      expect(answerRoute({ retry: null, judging: 'failed' }, TYPED, { text: 'finestra' })).toBe('server');
    });
  });

  describe('a hold met after a lost response', () => {
    const HELD = response(TYPED, PENDING);

    it('is the second try of an answer that could not have opened it', () => {
      expect(metHold(TYPED, { text: '' }, null, HELD)).toEqual(PENDING);
      expect(metHold(TYPED, { text: 'finestra' }, null, HELD)).toEqual(PENDING);
      expect(metHold(TYPED, { pass: 'show_answer' }, null, HELD)).toEqual(PENDING);
      expect(metHold(TYPED, { text: '', judged: 'alternative' }, null, HELD)).toEqual(PENDING);
    });

    it('is not, for an answer that may have opened it, or a second try, or no hold', () => {
      expect(metHold(TYPED, { text: 'vetrata' }, null, HELD)).toBeNull();
      expect(metHold(TYPED, { text: 'ספר', judged: 'alternative' }, null, HELD)).toBeNull();
      expect(metHold(TYPED, { text: '' }, PENDING, HELD)).toBeNull();
      expect(metHold(TYPED, { text: '' }, null, response(NEXT, null))).toBeNull();
    });
  });

  describe('sending an answer', () => {
    // A fake route: answers with each reply in turn, and records the retry
    // state each request was built for.
    const route = (answer: CardAnswer, replies: NextStepResponse[]) => {
      const sentWith: (PendingRetry | null)[] = [];
      const send = async (retry: PendingRetry | null): Promise<Sent> => {
        sentWith.push(retry);
        return { answer, next: replies[sentWith.length - 1] };
      };
      return { sentWith, send };
    };

    it('show the answer after a failed check, meeting the replayed hold, goes again with retry: true', async () => {
      const { sentWith, send } = route({ text: '' }, [response(TYPED, PENDING), response(NEXT, null)]);
      const settled = await settle(TYPED, null, send);
      expect(sentWith).toEqual([null, PENDING]);
      expect(settled).toEqual({ answer: { text: '' }, next: response(NEXT, null), met: PENDING });
      // The give-up's request is then the second try's.
      expect(nextStepRequest('t1', { text: '' }, sentWith[1])).toEqual({ question_id: 't1', text: '', retry: true });
    });

    it('an answer that opens the hold, or one that moves on, goes once', async () => {
      const opened = route({ text: 'vetrata' }, [response(TYPED, PENDING)]);
      expect((await settle(TYPED, null, opened.send)).met).toBeNull();
      expect(opened.sentWith).toEqual([null]);
      const moved = route({ text: '' }, [response(NEXT, null)]);
      expect((await settle(TYPED, null, moved.send)).met).toBeNull();
      expect(moved.sentWith).toEqual([null]);
    });

    it('a second try goes once, as one', async () => {
      const { sentWith, send } = route({ text: 'finestra' }, [response(NEXT, null)]);
      await settle(TYPED, PENDING, send);
      expect(sentWith).toEqual([PENDING]);
    });
  });

  describe('the second submit', () => {
    it('goes without retry first, and with retry: true once the card is held', () => {
      const ready: QuizState = { ...ON_CARD, judging: 'idle' };
      expect(nextStepRequest(TYPED.id, { text: 'vetrata' }, ready.retry)).toEqual({ question_id: 't1', text: 'vetrata' });
      const held = landed(ready, { text: 'vetrata' }, response(TYPED, PENDING), null);
      expect(nextStepRequest(TYPED.id, { text: 'finestra' }, held.retry)).toEqual({ question_id: 't1', text: 'finestra', retry: true });
      expect(nextStepRequest(TYPED.id, { text: '' }, held.retry)).toEqual({ question_id: 't1', text: '', retry: true });
      // A pass on it is the give-up.
      expect(nextStepRequest(TYPED.id, { pass: 'skip' }, held.retry)).toEqual({ question_id: 't1', pass: 'show_answer', retry: true });
      expect(nextStepRequest(TYPED.id, { option_index: 2 }, null)).toEqual({ question_id: 't1', option_index: 2 });
    });
  });
});

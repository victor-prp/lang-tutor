import { describe, expect, it } from '@jest/globals';
import type { NextStepResponse, PendingRetry, Question, SessionView } from '@lang-tutor/core/api';

import type { CardAnswer } from './feedback';
import {
  answeredState,
  answerRoute,
  applyQueued,
  continued,
  enteredState,
  holds,
  landed,
  metHold,
  nextStepRequest,
  passFor,
  queuedFrom,
  resumed,
  retried,
  retypeCheckedState,
  retypeTypingState,
  seenState,
  settle,
  type QuizState,
  type Sent,
} from './quiz';
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
  retype: null,
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
  const CLOZE: Question = {
    id: 'z1',
    type: 'cloze_typed',
    vocab_term_id: 'l',
    sentence: 'Please download the file.',
    gap: { start: 7, end: 15 },
    translation: 'בבקשה תוריד את הקובץ.',
    meaning: 'להוריד',
    answer: 'download',
    alternatives: ['upload'],
    mark: null,
  };
  const response = (question: Question, pending: PendingRetry | null): NextStepResponse => ({
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

    // Phase 41 (spec D3). The server checks it against the gap, so its banner waits.
    it('a typed gap word the phone calls wrong waits for the server, but not on a second try', () => {
      expect(answerRoute(FIRST, CLOZE, { text: 'edit' })).toBe('server');
      expect(answerRoute(FIRST, CLOZE, { text: '' })).toBe('banner');
      expect(answerRoute(FIRST, CLOZE, { text: 'download' })).toBe('banner');
      expect(answerRoute({ retry: PENDING, judging: 'idle' }, CLOZE, { text: 'edit' })).toBe('banner');
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

    // Review Focus 2: a checked word may be what opened the hold, so it is never resent as the second try.
    it('is not, for a typed gap word the server checked', () => {
      expect(metHold(CLOZE, { text: 'edit' }, null, response(CLOZE, { answer: 'edit', wording: 'word' }))).toBeNull();
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

  describe('hint_opened (phase 38 D4)', () => {
    it('goes with a first text answer, show the answer included', () => {
      expect(nextStepRequest('c1', { text: 'spent' }, null, true)).toEqual({ question_id: 'c1', text: 'spent', hint_opened: true });
      expect(nextStepRequest('c1', { text: '' }, null, false)).toEqual({ question_id: 'c1', text: '', hint_opened: false });
    });
    it('check_fit goes with a first text answer when asked, never with a retry (phase 41 D3)', () => {
      expect(nextStepRequest('c1', { text: 'edit' }, null, false, true)).toEqual({ question_id: 'c1', text: 'edit', hint_opened: false, check_fit: true });
      expect(nextStepRequest('c1', { text: 'edit' }, PENDING, false, true)).toEqual({ question_id: 'c1', text: 'edit', retry: true });
      expect(nextStepRequest('c1', { text: 'edit' }, null, false, false)).toEqual({ question_id: 'c1', text: 'edit', hint_opened: false });
    });
    it('never with a retry, and not when the card has none', () => {
      expect(nextStepRequest('c1', { text: 'spent' }, PENDING, true)).toEqual({ question_id: 'c1', text: 'spent', retry: true });
      expect(nextStepRequest('c1', { text: 'spent' }, null)).toEqual({ question_id: 'c1', text: 'spent' });
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

describe('the meet card (phase 54 D1, D6)', () => {
  const MEET: Question = { id: 'm1', type: 'meet', vocab_term_id: 'l', question: 'finestra', meaning: 'חלון' };
  const CHOICE: Question = {
    id: 'c1',
    type: 'multiple_choice',
    vocab_term_id: 'l',
    question: 'finestra',
    options: ['חלון', 'דלת'],
    correct_option: 0,
    context: null,
  };
  const ON_MEET: QuizState = { ...BASE, question: MEET, position: 1, total: 12, answer: null, advanceRequested: false, speakingOff: null, judging: 'idle' };

  it('is sent as seen, with no retry and nothing else', () => {
    expect(nextStepRequest('m1', { seen: true }, null)).toEqual({ question_id: 'm1', seen: true });
  });

  it('tapping through answers the card with seen and asks for the next one at once, so no banner waits', () => {
    expect(seenState(ON_MEET)).toMatchObject({ question: MEET, answer: { seen: true }, advanceRequested: true });
  });

  it('the next card arrives when the server answers, with no answer left on it', () => {
    const next: NextStepResponse = {
      session_id: 's',
      question: CHOICE,
      position: { position: 2, total: 12 },
      complete: false,
      pending_retry: null,
    };
    const moved = applyQueued(seenState(ON_MEET), queuedFrom(next));
    expect(moved).toMatchObject({ question: CHOICE, position: 2, answer: null, advanceRequested: false, retry: null });
  });
});

// Phase 55 (spec D6). Help, or a wrong tile, goes with the answer it led to.
describe('helped (phase 55 D6)', () => {
  const PENDING = { answer: 'vetrata', wording: 'word' } as const;

  it('goes in the body of a first text answer', () => {
    expect(nextStepRequest('t1', { text: 'finestra', helped: true }, null)).toEqual({ question_id: 't1', text: 'finestra', helped: true });
    expect(nextStepRequest('t1', { text: '', helped: false }, null)).toEqual({ question_id: 't1', text: '', helped: false });
  });

  it('goes with a second try too', () => {
    expect(nextStepRequest('t1', { text: 'finestra', helped: true }, PENDING)).toEqual({ question_id: 't1', text: 'finestra', helped: true, retry: true });
    expect(nextStepRequest('t1', { text: 'finestra', helped: false }, PENDING)).toEqual({ question_id: 't1', text: 'finestra', helped: false, retry: true });
  });

  it('is left out when the card does not say', () => {
    expect(nextStepRequest('t1', { text: 'finestra' }, null)).toStrictEqual({ question_id: 't1', text: 'finestra' });
    expect(nextStepRequest('t1', { text: 'finestra', helped: undefined }, null)).toStrictEqual({ question_id: 't1', text: 'finestra' });
    expect(nextStepRequest('c1', { text: 'spent', helped: undefined }, null, true)).toStrictEqual({ question_id: 'c1', text: 'spent', hint_opened: true });
  });
});

// Phase 55 (spec D7). A wrong or nearly right first typed answer opens the
// retype, which holds back the banner and Continue until it ends.
describe('the retype in the session (phase 55 D7)', () => {
  const TYPED: Question = {
    id: 't1',
    type: 'typed_translation',
    vocab_term_id: 'l',
    question: 'עיר',
    part_of_speech: 'noun',
    answer: 'città',
    lemma: 'città',
    alternatives: ['metropoli'],
    context: null,
  };
  const TILES: Question = {
    id: 'lt',
    type: 'letter_tiles',
    vocab_term_id: 'l',
    question: 'עיר',
    part_of_speech: 'noun',
    answer: 'città',
    tiles: ['c', 'i', 't', 't', 'à', 'o', 'e'],
  };
  const NEXT: Question = { ...TYPED, id: 't2', question: 'דלת', answer: 'porta', lemma: 'porta', alternatives: [] };
  const QUEUED = { complete: false, question: NEXT, position: 4, retry: null } as const;
  const ON_CARD: QuizState = { ...BASE, question: TYPED, position: 3, answer: null, advanceRequested: false, speakingOff: null, judging: 'idle' };
  const response = (question: Question, pending: PendingRetry | null): NextStepResponse => ({
    session_id: 's',
    question,
    position: { position: 4, total: 10 },
    complete: false,
    pending_retry: pending,
  });

  it('opens on a wrong first answer, a near miss and show the answer', () => {
    for (const text of ['paese', 'citta', '']) {
      expect(answeredState(ON_CARD, { text, helped: false })).toMatchObject({ answer: { text }, retype: { attempt: 1, showing: true, outcome: null } });
    }
    // Help does not change the text's own verdict.
    expect(answeredState(ON_CARD, { text: 'citta', helped: true }).retype).toEqual({ attempt: 1, showing: true, outcome: null });
  });

  it('does not open on the word, another accepted word, a second try or another card', () => {
    expect(answeredState(ON_CARD, { text: 'città', helped: false }).retype).toBeNull();
    expect(answeredState(ON_CARD, { text: 'città', helped: true }).retype).toBeNull();
    expect(answeredState(ON_CARD, { text: 'metropoli', helped: false }).retype).toBeNull();
    expect(answeredState({ ...ON_CARD, retry: { answer: 'metropoli', wording: 'word' } }, { text: 'paese', helped: false }).retype).toBeNull();
    expect(answeredState({ ...ON_CARD, question: TILES }, { text: '', helped: false }).retype).toBeNull();
  });

  it('opens when a first answer lands from the server, but not on a second try it resolved', () => {
    expect(landed({ ...ON_CARD, judging: 'checking' }, { text: 'paese' }, response(NEXT, null), null).retype).toEqual({ attempt: 1, showing: true, outcome: null });
    expect(landed({ ...ON_CARD, judging: 'checking' }, { text: '' }, response(NEXT, null), { answer: 'metropoli', wording: 'word' }).retype).toBeNull();
  });

  it('holds Continue while it is open, and the response stays queued', () => {
    const open = { ...answeredState(ON_CARD, { text: 'paese', helped: false }), queued: QUEUED };
    expect(continued(open)).toEqual(open);
    expect(continued({ ...open, queued: null })).toEqual({ ...open, queued: null });
  });

  it('typing hides the answer; checking it moves the attempt on', () => {
    const open = answeredState(ON_CARD, { text: 'paese', helped: false });
    expect(retypeTypingState(open).retype).toEqual({ attempt: 1, showing: false, outcome: null });
    expect(retypeCheckedState(open, 'citta').retype).toEqual({ attempt: 2, showing: true, outcome: null });
    // The first answer stays the card's answer: retypes are never sent.
    expect(retypeCheckedState(open, 'città')).toMatchObject({ answer: { text: 'paese' }, retype: { outcome: 'right' } });
  });

  it('lets Continue through once it has ended, right or failed', () => {
    const open = { ...answeredState(ON_CARD, { text: 'paese', helped: false }), queued: QUEUED };
    const right = retypeCheckedState(open, 'città');
    expect(continued(right)).toMatchObject({ question: NEXT, answer: null, retype: null });
    const failed = retypeCheckedState(retypeCheckedState(open, 'paese'), 'citta');
    expect(failed.retype?.outcome).toBe('failed');
    expect(continued({ ...failed, queued: null })).toMatchObject({ question: TYPED, advanceRequested: true });
  });

  it('a card with no retype continues as before', () => {
    const right = answeredState(ON_CARD, { text: 'città', helped: false });
    expect(continued({ ...right, queued: QUEUED })).toMatchObject({ question: NEXT, retype: null });
    expect(continued(right)).toMatchObject({ question: TYPED, advanceRequested: true });
  });

  it('checking or typing does nothing on a card with no retype open', () => {
    expect(retypeTypingState(ON_CARD)).toBe(ON_CARD);
    expect(retypeCheckedState(ON_CARD, 'città')).toBe(ON_CARD);
  });

  it('the next card has none', () => {
    const open = answeredState(ON_CARD, { text: 'paese', helped: false });
    expect(applyQueued(open, QUEUED).retype).toBeNull();
    expect(applyQueued(open, { complete: true, score: { correct: 0, total: 1 }, missedQuestions: [], progress: [] }).retype).toBeNull();
  });

  it('a session entered, or loaded mid-retype, starts with none', () => {
    const entered = enteredState('s9');
    expect(entered).toMatchObject({ sessionId: 's9', question: undefined, answer: null, retry: null, retype: null });
    const view: SessionView = {
      session_id: 's9',
      status: 'ready',
      source: 'list',
      position: { position: 4, total: 10 },
      question: NEXT,
      pending_retry: null,
      progress: [],
    };
    expect(resumed(entered, view)).toMatchObject({ question: NEXT, retype: null });
  });
});

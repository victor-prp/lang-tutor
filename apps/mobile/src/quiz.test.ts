import { describe, expect, it } from '@jest/globals';
import type { NextStepResponse, PendingRetry, Question, SessionView } from '@lang-tutor/core/api';

import type { CardAnswer } from './feedback';
import {
  answeredState,
  answerRoute,
  applyQueued,
  continued,
  enteredState,
  helpedFor,
  helpPressedState,
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
  tappedFor,
  wordTappedState,
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
  help: 0,
  helpPressed: false,
  helpMarks: null,
  tapped: [],
  explanation: null,
  heldNewWords: null,
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

  // Phase 70 (spec D6). What the view says the day's cap held back, while it is news.
  it('a resumed session carries the new words the cap held back, and none when the view has none', () => {
    const view: SessionView = {
      session_id: 's',
      status: 'ready',
      source: 'list',
      position: { position: 1, total: 10 },
      question: TYPED,
      pending_retry: null,
      progress: [],
    };
    expect(resumed(BASE, { ...view, held_new_words: { count: 2, day_cap: 15 } }).heldNewWords).toEqual({ count: 2, dayCap: 15 });
    expect(resumed(BASE, view).heldNewWords).toBeNull();
    expect(enteredState('s').heldNewWords).toBeNull();
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

    // Phase 66b (spec D2). A translation's sentence check lands with its answer.
    const EXPLAINED = { corrected: 'La finestra è aperta.', mistakes: [{ wrong: 'il', right: 'la', why: 'finestra היא נקבה' }] };

    it("keeps the sentence check that came with the answer, and none when it came with none", () => {
      expect(landed(ON_CARD, { text: 'il finestra', judged: 'exact' }, response(NEXT, null), null, EXPLAINED).explanation).toEqual(EXPLAINED);
      expect(landed(ON_CARD, { text: 'finestra' }, response(NEXT, null), null).explanation).toBeNull();
    });

    it('drops it for a hold, and the next card starts with none', () => {
      expect(landed(ON_CARD, { text: 'vetrata', judged: 'alternative' }, response(TYPED, PENDING), null, EXPLAINED).explanation).toBeNull();
      const answered = landed(ON_CARD, { text: 'il finestra', judged: 'exact' }, response(NEXT, null), null, EXPLAINED);
      expect(applyQueued(answered, answered.queued!).explanation).toBeNull();
      expect(enteredState('s1').explanation).toBeNull();
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

// Phase 56 (spec D5, D7). One help count a card, kept through its second try and
// through "can't speak now"; the retype on four more cards.
describe('help on more cards (phase 56 D5, D7)', () => {
  const SAY: Question = { id: 's1', type: 'say_translation', vocab_term_id: 'l', question: 'מדבר', part_of_speech: 'verb', answer: 'parlo', lemma: 'parlare', alternatives: ['dico'], context: null };
  const DICTATION: Question = { id: 'd1', type: 'dictation', vocab_term_id: 'l', question: 'parlo', meaning: 'מדבר' };
  const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l', question: 'parlare', part_of_speech: 'verb', meaning: 'לדבר', context: null };
  const TRANSLATE: Question = { id: 'st', type: 'sentence_translation', vocab_term_id: 'l', question: 'בואו נשלב כוחות.', meaning: 'לשלב', sentence: 'Uniamo le forze.', gap: { start: 0, end: 6 }, answer: 'Uniamo', mark: null };
  const TILES: Question = { id: 'lt', type: 'letter_tiles', vocab_term_id: 'l', question: 'עיר', part_of_speech: 'noun', answer: 'città', tiles: ['c', 'i', 't', 't', 'à', 'o', 'e'] };
  const CHOICE: Question = { id: 'q1', type: 'multiple_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת'], correct_option: 0, context: null };
  const ON = (question: Question): QuizState => ({ ...BASE, question, position: 3, answer: null, advanceRequested: false, speakingOff: null, judging: 'idle' });
  const response = (question: Question, pending: PendingRetry | null): NextStepResponse => ({
    session_id: 's',
    question,
    position: { position: 4, total: 10 },
    complete: false,
    pending_retry: pending,
  });

  it('counts presses on the card, from none on a session entered', () => {
    expect(enteredState('s9').help).toBe(0);
    expect(helpPressedState(helpPressedState(ON(SAY))).help).toBe(2);
  });

  it('starts a new card at none, and keeps the count when the same card comes back for its second try', () => {
    const helped = { ...ON(SAY), help: 3 };
    expect(applyQueued(helped, { complete: false, question: DICTATION, position: 4, retry: null }).help).toBe(0);
    expect(applyQueued(helped, { complete: false, question: SAY, position: 3, retry: { answer: 'dico', wording: 'word' } }).help).toBe(3);
    expect(applyQueued(helped, { complete: true, score: { correct: 0, total: 1 }, missedQuestions: [], progress: [] }).help).toBe(0);
  });

  // Final review (spec D5). A spoken card passed after help says so; a pass without one does not.
  it('a pass says whether the card was helped', () => {
    expect(nextStepRequest('s1', { pass: 'show_answer', helped: true }, null)).toEqual({ question_id: 's1', pass: 'show_answer', helped: true });
    expect(nextStepRequest('s1', { pass: 'skip', helped: false }, null)).toEqual({ question_id: 's1', pass: 'skip', helped: false });
    expect(nextStepRequest('s1', { pass: 'skip', helped: true }, { answer: 'dico', wording: 'word' })).toEqual({ question_id: 's1', pass: 'show_answer', helped: true, retry: true });
    expect(nextStepRequest('r1', { pass: 'skip' }, null)).toStrictEqual({ question_id: 'r1', pass: 'skip' });
  });

  it('a helped judged answer never opened the hold its response carries: it met one', () => {
    const held = response(MEANING, { answer: 'לומר', wording: 'meaning' });
    expect(metHold(MEANING, { text: 'לדבר', judged: 'exact', helped: true }, null, held)).toEqual({ answer: 'לומר', wording: 'meaning' });
    expect(metHold(MEANING, { text: 'לדבר', judged: 'exact', helped: false }, null, held)).toBeNull();
  });

  it('says a card that takes help was helped once help was pressed; tiles say it themselves', () => {
    expect(helpedFor(SAY, 0)).toBe(false);
    expect(helpedFor(SAY, 1)).toBe(true);
    expect(helpedFor(MEANING, 2)).toBe(true);
    expect(helpedFor(TRANSLATE, 0)).toBe(false);
    expect(helpedFor(TILES, 0, { helped: true })).toBe(true);
    expect(helpedFor(TILES, 4, { helped: false })).toBe(false);
    // Phase 63 (spec D10): a choice takes help now; a new meaning does not.
    expect(helpedFor(CHOICE, 2)).toBe(true);
    expect(helpedFor(CHOICE, 0)).toBe(false);
    expect(helpedFor({ ...CHOICE, type: 'new_meaning', known_meanings: [] } as Question, 2)).toBeUndefined();
  });

  it('opens the retype on a wrong dictation and a wrong typed say the translation', () => {
    expect(answeredState(ON(DICTATION), { text: 'casa', helped: false }).retype).toEqual({ attempt: 1, showing: true, outcome: null });
    expect(answeredState({ ...ON(SAY), speakingOff: 'chosen' }, { text: '', helped: true }).retype).toEqual({ attempt: 1, showing: true, outcome: null });
    expect(answeredState(ON(DICTATION), { text: 'parlo', helped: false }).retype).toBeNull();
  });

  it('opens the retype when a typed meaning the judge called wrong lands, not a right one or a translation', () => {
    const checking = (question: Question): QuizState => ({ ...ON(question), judging: 'checking' });
    expect(landed(checking(MEANING), { text: 'לאכול', judged: 'wrong' }, response(DICTATION, null), null).retype).toEqual({ attempt: 1, showing: true, outcome: null });
    expect(landed(checking(MEANING), { text: 'לדבר', judged: 'exact' }, response(DICTATION, null), null).retype).toBeNull();
    expect(landed(checking(TRANSLATE), { text: 'Andiamo.', judged: 'wrong' }, response(DICTATION, null), null).retype).toBeNull();
    // A second try has its own banners.
    expect(landed(checking(MEANING), { text: '', judged: 'wrong' }, response(DICTATION, null), { answer: 'לומר', wording: 'meaning' }).retype).toBeNull();
  });

  it('checks a retype on a typed meaning and a dictation', () => {
    const meaning = landed({ ...ON(MEANING), judging: 'checking' }, { text: 'לאכול', judged: 'wrong' }, response(DICTATION, null), null);
    expect(retypeCheckedState(meaning, 'לדבר').retype).toMatchObject({ outcome: 'right' });
    const dictation = answeredState(ON(DICTATION), { text: 'casa', helped: false });
    expect(retypeCheckedState(dictation, 'parla').retype).toEqual({ attempt: 2, showing: true, outcome: null });
  });
});

// Phase 59 (spec D3, D5). Taps on a sentence translation's words: one list a card,
// kept through its second try, the target's tap help that reveals the whole word.
describe('taps on a sentence translation (phase 59 D3, D5)', () => {
  const WORDS = [
    { start: 0, end: 4, text: 'Vado', target: false },
    { start: 5, end: 7, text: 'con', target: true },
    { start: 8, end: 13, text: 'amici', target: false },
  ];
  const TRANSLATE: Question = { id: 'st', type: 'sentence_translation', vocab_term_id: 'l', question: 'אני הולך עם חברים.', meaning: 'עם', sentence: 'Vado con amici.', gap: { start: 5, end: 8 }, answer: 'con', mark: { start: 9, end: 11 }, words: WORDS };
  const OLD: Question = { ...TRANSLATE, words: null };
  const SAY: Question = { id: 's1', type: 'say_translation', vocab_term_id: 'l', question: 'מדבר', part_of_speech: 'verb', answer: 'parlo', lemma: 'parlare', alternatives: [], context: null };
  const ON = (question: Question): QuizState => ({ ...enteredState('s'), question, position: 3 });

  it('keeps each word once, in the order first tapped, from none on a session entered', () => {
    expect(enteredState('s').tapped).toEqual([]);
    const tapped = wordTappedState(wordTappedState(wordTappedState(ON(TRANSLATE), 2), 0), 2);
    expect(tapped.tapped).toEqual([2, 0]);
    expect(tapped.help).toBe(0);
  });

  it('makes a tap on the target help, revealing the whole word', () => {
    const tapped = wordTappedState(ON(TRANSLATE), 1);
    expect(tapped.tapped).toEqual([1]);
    expect(tapped.help).toBe(3);
    expect(helpedFor(TRANSLATE, tapped.help)).toBe(true);
  });

  it('on a card with no word map, takes a tap on the mark as help and keeps no index', () => {
    const tapped = wordTappedState(ON(OLD), 'mark');
    expect(tapped.tapped).toEqual([]);
    expect(tapped.help).toBe(3);
  });

  it('takes no tap once answered, out of range, or on another card', () => {
    const answered = { ...ON(TRANSLATE), answer: { text: 'x', judged: 'wrong' as const } };
    expect(wordTappedState(answered, 0)).toBe(answered);
    expect(wordTappedState(ON(TRANSLATE), 7).tapped).toEqual([]);
    expect(wordTappedState(ON(SAY), 0).tapped).toEqual([]);
  });

  it('starts a new card with none, and keeps them when the same card comes back for its second try', () => {
    const tapped = { ...ON(TRANSLATE), tapped: [2] };
    expect(applyQueued(tapped, { complete: false, question: SAY, position: 4, retry: null }).tapped).toEqual([]);
    expect(applyQueued(tapped, { complete: false, question: TRANSLATE, position: 3, retry: { answer: 'x', wording: 'meaning' } }).tapped).toEqual([2]);
  });

  it('sends the taps only on a sentence translation that has some', () => {
    expect(tappedFor(TRANSLATE, [2, 0])).toEqual([2, 0]);
    expect(tappedFor(TRANSLATE, [])).toBeUndefined();
    expect(tappedFor(SAY, [1])).toBeUndefined();
  });
});

// Phase 62 (spec D3, D6). Taps on every card that taps a sentence: a gap card's
// sentence, a word card's target-language line. Their target is never tapped.
describe('taps on every sentence card (phase 62 D3, D6)', () => {
  const CLOZE: Question = {
    id: 'c1', type: 'cloze_choice', vocab_term_id: 'l', sentence: 'La casa è grande.', gap: { start: 10, end: 16 }, translation: 'הבית גדול.', meaning: 'גדול',
    options: ['grande', 'rossa', 'lenta', 'calda'], correct_option: 0,
    words: [{ start: 0, end: 7, text: 'הבית', target: false }, { start: 10, end: 16, text: 'גדול', target: true }],
  };
  const CHOICE: Question = {
    id: 'm1', type: 'multiple_choice', vocab_term_id: 'l', question: 'poi', options: ['אחר כך', 'כבר', 'תמיד', 'אף פעם'], correct_option: 0,
    context: {
      text: 'Mangiamo e poi usciamo.', mark: { start: 11, end: 14 }, translation: 'אוכלים ואחר כך יוצאים.',
      words: [{ start: 0, end: 8, text: 'אוכלים', target: false }, { start: 11, end: 14, text: 'אחר כך', target: true }, { start: 15, end: 22, text: 'יוצאים', target: false }],
    },
  };
  const REVERSE: Question = { id: 'r1', type: 'reverse_choice', vocab_term_id: 'l', question: 'אחר כך', part_of_speech: 'adverb', options: ['poi', 'già', 'mai', 'sempre'], correct_option: 0, context: { text: 'אוכלים ואחר כך יוצאים.', mark: null } };
  const ON = (question: Question): QuizState => ({ ...enteredState('s'), question, position: 3 });

  it('keeps a cloze\'s taps by index, once each, and never its target, the gap', () => {
    const tapped = wordTappedState(wordTappedState(wordTappedState(ON(CLOZE), 0), 1), 0);
    expect(tapped.tapped).toEqual([0]);
    expect(tapped.help).toBe(0);
  });

  it('reads a word card\'s taps from its context line, never its target', () => {
    expect(wordTappedState(wordTappedState(ON(CHOICE), 2), 1).tapped).toEqual([2]);
  });

  it('takes no tap once answered, nor on a Hebrew-context card', () => {
    const answered = { ...ON(CLOZE), answer: { option_index: 0 } };
    expect(wordTappedState(answered, 0)).toBe(answered);
    expect(wordTappedState(ON(REVERSE), 0).tapped).toEqual([]);
  });

  it('sends the taps on every tapped card, and none on a Hebrew-context card', () => {
    expect(tappedFor(CLOZE, [0])).toEqual([0]);
    expect(tappedFor(CHOICE, [2, 0])).toEqual([2, 0]);
    expect(tappedFor(REVERSE, [0])).toBeUndefined();
    expect(tappedFor(CHOICE, [])).toBeUndefined();
  });

  it('carries the taps on a chosen option and a typed text, and nothing without them', () => {
    expect(nextStepRequest('c1', { option_index: 0 }, null, undefined, false, [0])).toEqual({ question_id: 'c1', option_index: 0, tapped: [0] });
    expect(nextStepRequest('c1', { text: 'grande' }, null, undefined, false, [0, 2])).toEqual({ question_id: 'c1', text: 'grande', tapped: [0, 2] });
    expect(nextStepRequest('c1', { option_index: 0 }, null)).toEqual({ question_id: 'c1', option_index: 0 });
  });
});

// Phase 63 (spec D3, D10). On a typed card a press reads the typing: it marks
// from the first wrong character, or gives the step after a right start. A press
// that only marks still makes the card helped; a choice card counts presses.
describe('help reads the typing (phase 63 D3, D10)', () => {
  const TYPED: Question = { id: 't1', type: 'typed_translation', vocab_term_id: 'l', question: 'ארוחת בוקר', part_of_speech: 'noun', answer: 'colazione', lemma: 'colazione', alternatives: [], context: null };
  const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l', question: 'colazione', part_of_speech: 'noun', meaning: 'ארוחה', context: null };
  const SAY: Question = { id: 's1', type: 'say_translation', vocab_term_id: 'l', question: 'מדבר', part_of_speech: 'verb', answer: 'parlo', lemma: 'parlare', alternatives: [], context: null };
  const CHOICE: Question = { id: 'q1', type: 'multiple_choice', vocab_term_id: 'l', question: 'casa', options: ['בית', 'דלת', 'גג', 'קיר'], correct_option: 0, context: null };
  const ON = (question: Question): QuizState => ({ ...BASE, question, position: 3, answer: null, advanceRequested: false, speakingOff: null, judging: 'idle' });

  it('marks from the first wrong letter, gives nothing, and makes the card helped', () => {
    const marked = helpPressedState({ ...ON(TYPED), help: 2 }, 'calazo');
    expect(marked).toMatchObject({ help: 2, helpPressed: true, helpMarks: { text: 'calazo', from: 1 } });
    expect(helpedFor(TYPED, marked.help, undefined, marked.helpPressed)).toBe(true);
    expect(helpedFor(TYPED, 0, undefined, true)).toBe(true);
  });

  it('gives the step after a right start, and clears the marks', () => {
    const marked = helpPressedState({ ...ON(TYPED), help: 2 }, 'calazo');
    expect(helpPressedState(marked, 'colazi')).toMatchObject({ help: 7, helpPressed: true, helpMarks: null });
  });

  it('compares a typed meaning as Hebrew', () => {
    expect(helpPressedState(ON(MEANING), 'אֲר')).toMatchObject({ help: 3, helpMarks: null });
  });

  // A press handler handed a button's event must not read it as typed text.
  it('takes anything but a string as no typing', () => {
    expect(helpPressedState(ON(SAY), { nativeEvent: {} } as unknown as string)).toMatchObject({ help: 1, helpPressed: true, helpMarks: null });
  });

  it('adds one step a press where nothing is typed: spoken, listening, a choice', () => {
    expect(helpPressedState(ON(SAY))).toMatchObject({ help: 1, helpPressed: true });
    expect(helpPressedState(helpPressedState(ON(CHOICE)))).toMatchObject({ help: 2, helpPressed: true });
  });

  // Review focus 5: the same card back for its second try keeps its help.
  it('keeps help through a second try, and resets it on the next card', () => {
    const pressed = { ...ON(TYPED), help: 3, helpPressed: true, helpMarks: { text: 'cx', from: 1 } };
    expect(applyQueued(pressed, { complete: false, question: TYPED, position: 3, retry: { answer: 'pasto', wording: 'word' } })).toMatchObject({
      help: 3,
      helpPressed: true,
      helpMarks: null,
    });
    expect(applyQueued(pressed, { complete: false, question: SAY, position: 4, retry: null })).toMatchObject({ help: 0, helpPressed: false, helpMarks: null });
    expect(enteredState('s2')).toMatchObject({ help: 0, helpPressed: false, helpMarks: null });
  });

  it('sends helped with an option', () => {
    expect(nextStepRequest('q1', { option_index: 2, helped: true }, null)).toEqual({ question_id: 'q1', option_index: 2, helped: true });
    expect(nextStepRequest('q1', { option_index: 2 }, null)).toStrictEqual({ question_id: 'q1', option_index: 2 });
  });
});

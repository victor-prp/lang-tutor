import type { MissedQuestion, NextStepResponse, PendingRetry, Question, Score, SessionProgressItem, SessionView } from '@lang-tutor/core/api';

import type { CardAnswer } from '@/feedback';
import type { JudgeAttempt } from '@/judging';
import { IDLE_ATTEMPT, type SpeakingOff, type SpeechAttempt } from '@/speaking';

// What the background next-step call resolved to, waiting to be applied when
// the learner taps Continue. Only one of these is ever in flight at a time,
// since `select` cannot fire again until a new question is on screen.
// Phase 34 (spec D9): `retry` is set when the card is the one just answered,
// held for its second try.
export type Queued =
  | { complete: false; question: Question; position: number; retry: PendingRetry | null }
  | { complete: true; score: Score; missedQuestions: MissedQuestion[]; progress: SessionProgressItem[] };

export type QuizState = {
  sessionId: string;
  question: Question | undefined;
  position: number;
  total: number;
  answer: CardAnswer | null;
  complete: boolean;
  correctCount: number;
  missedQuestions: MissedQuestion[];
  progress: SessionProgressItem[];
  queued: Queued | null;
  // Set when Continue is tapped before the background next-step call has
  // resolved. Applied the moment that call does resolve, so the learner
  // never has to tap Continue a second time.
  advanceRequested: boolean;
  speech: SpeechAttempt;
  speakingOff: SpeakingOff;
  /** Phase 27 (spec D13). A judged card's check; idle on every new card.
   *  Phase 34: also a typed card's answer that opens a second try, which
   *  waits for the server to hold the card. */
  judging: JudgeAttempt;
  /** Phase 34 (spec D9). The card on screen is held for its second try: the
   *  first answer, and which line to show. Null on every other card. */
  retry: PendingRetry | null;
};

export function queuedFrom(response: NextStepResponse): Queued {
  return response.complete
    ? { complete: true, score: response.score, missedQuestions: response.missed_questions, progress: response.progress }
    : { complete: false, question: response.question, position: response.position.position, retry: response.pending_retry };
}

/** Phase 34 (spec D9). Whether a response holds the card just answered for its
 *  second try. It applies at once: there is no banner to continue from. */
export function holds(queued: Queued): boolean {
  return !queued.complete && queued.retry !== null;
}

export function applyQueued(current: QuizState, queued: Queued): QuizState {
  if (queued.complete) {
    return {
      ...current,
      question: undefined,
      complete: true,
      correctCount: queued.score.correct,
      // Spec D9: a skipped card is left out of the total.
      total: queued.score.total,
      missedQuestions: queued.missedQuestions,
      progress: queued.progress,
      answer: null,
      queued: null,
      advanceRequested: false,
      speech: IDLE_ATTEMPT,
      judging: 'idle',
      retry: null,
    };
  }
  return {
    ...current,
    question: queued.question,
    position: queued.position,
    answer: null,
    queued: null,
    advanceRequested: false,
    speech: IDLE_ATTEMPT,
    judging: 'idle',
    retry: queued.retry,
  };
}

/** Phase 19. A loaded session continues from its current card. Phase 34 (spec
 *  D9): a card whose first answer is pending opens on its second try. */
export function resumed(current: QuizState, view: SessionView): QuizState {
  if (!view.question) return current;
  return {
    ...current,
    question: view.question,
    position: view.position.position,
    total: view.position.total,
    retry: view.pending_retry,
  };
}

/** Phase 34 (spec D9). An answer's request: the second try at a card held for
 *  one carries `retry: true`; without it, the server replays the first answer. */
export function retried<T extends object>(request: T, retry: PendingRetry | null): T & { retry?: true } {
  return retry === null ? request : { ...request, retry: true };
}

/** Phase 34 (spec D9). A pass on a second try is the give-up: D9 resolves a
 *  retry by an answer or by "show the answer", never by a skip. */
export function passFor(kind: 'skip' | 'show_answer', retry: PendingRetry | null): 'skip' | 'show_answer' {
  return retry === null ? kind : 'show_answer';
}

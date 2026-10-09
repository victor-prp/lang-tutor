import type { MissedQuestion, NextStepResponse, Question, Score, SessionProgressItem } from '@lang-tutor/core/api';

import type { CardAnswer } from '@/feedback';
import type { JudgeAttempt } from '@/judging';
import { IDLE_ATTEMPT, type SpeakingOff, type SpeechAttempt } from '@/speaking';

// What the background next-step call resolved to, waiting to be applied when
// the learner taps Continue. Only one of these is ever in flight at a time,
// since `select` cannot fire again until a new question is on screen.
export type Queued =
  | { complete: false; question: Question; position: number }
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
  /** Phase 27 (spec D13). A judged card's check; idle on every new card. */
  judging: JudgeAttempt;
};

export function queuedFrom(response: NextStepResponse): Queued {
  return response.complete
    ? { complete: true, score: response.score, missedQuestions: response.missed_questions, progress: response.progress }
    : { complete: false, question: response.question, position: response.position.position };
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
  };
}

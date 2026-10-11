import type {
  MissedQuestion,
  NextStepRequest,
  NextStepResponse,
  PendingRetry,
  Question,
  Score,
  SessionProgressItem,
  SessionView,
} from '@lang-tutor/core/api';

import { opensRetry, type CardAnswer } from '@/feedback';
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

/** Phase 34 (spec D9). The next-step request for an answer to the card on
 *  screen: on a second try it carries `retry: true`, and a pass is the give-up.
 *  Phase 38 (spec D4): a first text answer carries `hint_opened` when the card
 *  has a hint; a retry never does, as the hint it opened is the app's doing. */
export function nextStepRequest(
  questionId: string,
  input: { option_index: number } | { text: string } | { pass: 'skip' | 'show_answer' },
  retry: PendingRetry | null,
  hintOpened?: boolean,
): NextStepRequest {
  const request = 'pass' in input ? { question_id: questionId, pass: passFor(input.pass, retry) } : { question_id: questionId, ...input };
  const hinted = 'text' in input && retry === null && hintOpened !== undefined ? { ...request, hint_opened: hintOpened } : request;
  return retried(hinted, retry);
}

/** Phase 34 (spec D9). How an answer the phone judges goes out. `banner`: its
 *  banner shows at once and its response is queued for Continue, as before.
 *  `server`: the card waits for the response first. That is another accepted
 *  word, which holds the card for a second try whose banner must not name the
 *  saved word; and any answer after a failed check, since the server may hold
 *  a first answer already, and only its response says whether this answer is
 *  that card's second try (`settle`). A second try's banner shows at once. */
export function answerRoute(
  state: Pick<QuizState, 'retry' | 'judging'>,
  question: Question,
  answer: { option_index: number } | { text: string },
): 'banner' | 'server' {
  if (state.retry !== null) return 'banner';
  return state.judging === 'failed' || opensRetry(question, answer) ? 'server' : 'banner';
}

/** What a sent answer came back as: the answer the card shows, and the step. */
export type Sent = { answer: CardAnswer; next: NextStepResponse };

/** Phase 34 (spec D9). A sent answer once settled: `met` is the hold it met and
 *  resolved as that card's second try (see metHold), or null. */
export type Settled = Sent & { met: PendingRetry | null };

/** Phase 34 (spec D9). Whether an answer may be what opened the hold its own
 *  response carries. A pass or an empty text never opens one; a judged text
 *  may, and only the server knows; a clip or a board is never sent twice. */
function mayOpen(question: Question, answer: CardAnswer): boolean {
  if ('pass' in answer) return false;
  if ('judged' in answer) return answer.text.trim() !== '';
  if ('heard' in answer || 'board' in answer) return true;
  return opensRetry(question, answer);
}

/** Phase 34 (spec D9). The hold a first answer's response carries when that
 *  answer could not have opened it: an earlier answer was recorded and held,
 *  its response was lost, and the server replayed the hold. This answer, a
 *  "show the answer" above all, is then the card's second try. Null when the
 *  answer was already a second try, may have opened the hold, or met none. */
export function metHold(question: Question, answer: CardAnswer, retry: PendingRetry | null, next: NextStepResponse): PendingRetry | null {
  if (retry !== null || next.complete || next.pending_retry === null) return null;
  return mayOpen(question, answer) ? null : next.pending_retry;
}

/** Phase 34 (spec D9). Sends an answer through `send`, which builds the request
 *  for a retry state. A response holding the card for an answer recorded
 *  before this one (metHold) sends it again, as the second try, with
 *  `retry: true`: a "show the answer" must not reveal the saved word and leave
 *  the card open for it. */
export async function settle(
  question: Question,
  retry: PendingRetry | null,
  send: (retry: PendingRetry | null) => Promise<Sent>,
): Promise<Settled> {
  const first = await send(retry);
  const met = metHold(question, first.answer, retry, first.next);
  return met === null ? { ...first, met } : { ...(await send(met)), met };
}

/** Phase 34 (spec D9). The card once its answer's response lands. A hold opens
 *  the second try at once, with no banner to continue from. Otherwise the card
 *  is answered and the next step queued; `met` is a hold this answer resolved,
 *  kept with a second try's own so the banner is a second try's (ruling R16). */
export function landed(current: QuizState, answer: CardAnswer, next: NextStepResponse, met: PendingRetry | null): QuizState {
  const queued = queuedFrom(next);
  if (holds(queued)) return applyQueued(current, queued);
  return { ...current, judging: 'idle', speech: IDLE_ATTEMPT, answer, queued, retry: met ?? current.retry };
}

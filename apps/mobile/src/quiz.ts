import type {
  ExplainResponse,
  MissedQuestion,
  NextStepRequest,
  NextStepResponse,
  PendingRetry,
  Question,
  Score,
  SessionProgressItem,
  SessionView,
} from '@lang-tutor/core/api';
import { SESSION_LENGTH, TAPPABLE_TYPES, takesHelp } from '@lang-tutor/core/domain';

import { checksFit, opensRetry, type CardAnswer } from '@/feedback';
import type { JudgeAttempt } from '@/judging';
import type { HeldNewWords } from '@/newWordLimits';
import { opensRetype, retypeChecked, retypeTyping, startRetype, type Retype } from '@/retype';
import { IDLE_ATTEMPT, type SpeakingOff, type SpeechAttempt } from '@/speaking';
import type { ServedWord } from '@/taps';
import { helpText, pressTyped, wholeForm } from '@/typedHelp';

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
  /** Phase 55 (spec D7). The card's retype after a wrong or nearly right first
   *  typed answer: open, it holds back the banner and Continue. Null on every
   *  other card, and on a session entered or resumed, since it is never sent. */
  retype: Retype | null;
  /** Phase 56 (spec D5). How many characters help has revealed on the card on
   *  screen: one count a card, kept through its second try and through "can't
   *  speak now", 0 on the next card. The tiles card counts its own. */
  help: number;
  /** Phase 63 (spec D3). Whether help was pressed on the card on screen, a press
   *  that only marked a mistake included: what makes its answer helped. Kept as
   *  `help` is. */
  helpPressed: boolean;
  /** Phase 63 (spec D3). The typed text the last press marked, from its first
   *  wrong character: shown while the input still holds exactly that text. */
  helpMarks: { text: string; from: number } | null;
  /** Phase 59 (spec D3, D5). The words of a sentence translation tapped, by their
   *  index in its `words`, in the order first tapped: kept through its second
   *  try, none on the next card. */
  tapped: number[];
  /** Phase 66b (spec D2). A sentence translation's check, which came with its
   *  answer: null until then, when it was not checked, and on every other card. */
  explanation: ExplainResponse | null;
  /** Phase 70 (spec D6). What the session's view says the day's cap held back, while it is news:
   *  null until the view is read, and when it says nothing. */
  heldNewWords: HeldNewWords | null;
  /** Phase 72 (spec D1). The target whose path the session is on, from its read; null on the main path's
   *  and until the read lands. The results screen continues on it. */
  targetId: string | null;
};

/** Phase 19. What a session starts as before its first card is read: starting
 *  and resuming are the same call. */
export function enteredState(sessionId: string): QuizState {
  return {
    sessionId,
    question: undefined,
    position: 0,
    total: SESSION_LENGTH,
    answer: null,
    complete: false,
    correctCount: 0,
    missedQuestions: [],
    progress: [],
    queued: null,
    advanceRequested: false,
    speech: IDLE_ATTEMPT,
    speakingOff: null,
    judging: 'idle',
    retry: null,
    retype: null,
    help: 0,
    helpPressed: false,
    helpMarks: null,
    tapped: [],
    explanation: null,
    heldNewWords: null,
    targetId: null,
  };
}

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
      retype: null,
      help: 0,
      helpPressed: false,
      helpMarks: null,
      tapped: [],
      explanation: null,
    };
  }
  const same = queued.question.id === current.question?.id;
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
    retype: null,
    // Phase 56 (spec D5): the same card back for its second try keeps its help.
    help: same ? current.help : 0,
    // Phase 63 (spec D3): and whether it was pressed; its marks were for the text
    // the first try sent.
    helpPressed: same ? current.helpPressed : false,
    helpMarks: null,
    // Phase 59 (spec D5): and its taps.
    tapped: same ? current.tapped : [],
    explanation: null,
  };
}

/** Phase 62 (spec D3). The word map of the sentence a card taps: a gap card's
 *  or a translation's own, a word card's on its context line; none elsewhere. */
export function tapWordsOf(question: Question): readonly ServedWord[] | null {
  if (!TAPPABLE_TYPES.has(question.type)) return null;
  if ('words' in question) return question.words ?? null;
  return 'context' in question ? (question.context?.words ?? null) : null;
}

/** Phase 59 (spec D3). A word of the sentence translation on screen tapped: its
 *  index, kept once; `'mark'` is the practised word on a card with no word map.
 *  A tap on the practised word is help that shows the whole form. An answered
 *  card, another card and an index the map has no word at take none. Phase 62
 *  (spec D3): any card that taps a sentence, whose practised word, though, is
 *  the gap or the question itself, so only a translation's can be tapped. */
export function wordTappedState(current: QuizState, tap: number | 'mark'): QuizState {
  const question = current.question;
  if (current.answer !== null || !question) return current;
  if (question.type !== 'sentence_translation') {
    const word = tap === 'mark' ? null : tapWordsOf(question)?.[tap];
    if (!word || word.target || current.tapped.includes(tap as number)) return current;
    return { ...current, tapped: [...current.tapped, tap as number] };
  }
  const word = tap === 'mark' ? null : question.words?.[tap];
  if (tap !== 'mark' && !word) return current;
  const target = tap === 'mark' || word!.target;
  const tapped = tap === 'mark' || current.tapped.includes(tap) ? current.tapped : [...current.tapped, tap];
  if (!target) return { ...current, tapped };
  return { ...current, tapped, help: Math.max(current.help, wholeForm(question.answer)), helpPressed: true };
}

/** Phase 59 (spec D5). The `tapped` an answer to `question` carries: none on a
 *  card that taps no sentence (phase 62: every other one carries them), or with no taps. */
export function tappedFor(question: Question, tapped: readonly number[]): number[] | undefined {
  return TAPPABLE_TYPES.has(question.type) && tapped.length > 0 ? [...tapped] : undefined;
}

/** Phase 56 (spec D5). Help pressed on the card on screen: one more character
 *  shown. An answered card takes none (a retype offers no help).
 *  Phase 63 (spec D3): on a typed card, with what is typed, a press reads it:
 *  marks from its first wrong character, or gives the step after a right start. */
export function helpPressedState(current: QuizState, typed?: string): QuizState {
  if (current.answer !== null || !current.question) return current;
  // Only text is typing: a press handler may be handed a button's event.
  const target = typeof typed === 'string' ? helpText(current.question) : null;
  if (target === null || typeof typed !== 'string') return { ...current, help: current.help + 1, helpPressed: true };
  const pressed = pressTyped(target, typed, current.help, current.question.type === 'typed_meaning');
  return {
    ...current,
    help: pressed.given,
    helpPressed: true,
    helpMarks: pressed.markFrom === null ? null : { text: typed, from: pressed.markFrom },
  };
}

/** Phase 56 (spec D5). The `helped` an answer to `question` carries: none on a
 *  card that takes no help; the tiles card's own say (a wrong tile helps, phase
 *  55); on every other card, whether help was pressed on it. */
export function helpedFor(question: Question, help: number, card?: { helped?: boolean }, pressed = false): boolean | undefined {
  if (!takesHelp(question.type)) return undefined;
  // Phase 63 (spec D3): a press that only marked a mistake gave no step, and helps.
  return question.type === 'letter_tiles' ? card?.helped === true : help > 0 || pressed;
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
    heldNewWords: view.held_new_words ? { count: view.held_new_words.count, dayCap: view.held_new_words.day_cap } : null,
    targetId: view.target_id ?? null,
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
 *  has a hint; a retry never does, as the hint it opened is the app's doing.
 *  Phase 55 (spec D6): a text answer carries `helped` when the card said, a
 *  second try included, since help on the card so far counts. Phase 56 (spec
 *  D5): so does a pass, a spoken card given up after help. */
export function nextStepRequest(
  questionId: string,
  input: { option_index: number; helped?: boolean } | { text: string; helped?: boolean } | { pass: 'skip' | 'show_answer'; helped?: boolean } | { seen: true },
  retry: PendingRetry | null,
  hintOpened?: boolean,
  checkFit = false,
  /** Phase 62 (spec D6). The words tapped on the card, sent with its option or its text. */
  tapped?: readonly number[],
): NextStepRequest {
  // Phase 54 (spec D6). A meet card is tapped through once: it is never held for a second try.
  if ('seen' in input) return { question_id: questionId, seen: true };
  const request =
    'pass' in input
      ? { question_id: questionId, pass: passFor(input.pass, retry), ...(input.helped === undefined ? {} : { helped: input.helped }) }
      : 'text' in input
        ? { question_id: questionId, text: input.text, ...(input.helped === undefined ? {} : { helped: input.helped }) }
        : { question_id: questionId, ...input };
  const hinted = 'text' in input && retry === null && hintOpened !== undefined ? { ...request, hint_opened: hintOpened } : request;
  // Phase 41 (spec D3): only a first answer is checked against the gap.
  const checked = 'text' in input && retry === null && checkFit ? { ...hinted, check_fit: true } : hinted;
  const taps = tapped && tapped.length > 0 && ('text' in input || 'option_index' in input) ? { ...checked, tapped: [...tapped] } : checked;
  return retried(taps, retry);
}

/** Phase 55 (spec D7). The retype a card's answer opens: a first answer to a
 *  typed translation whose text is wrong or nearly right, show the answer
 *  included. Not a second try (phase 34), which has its own banners. Phase 56
 *  (spec D7): on a dictation, a typed gap and a typed say the translation too,
 *  and on a typed meaning the judge called wrong. */
function retypeFor(question: Question | undefined, answer: CardAnswer, retry: PendingRetry | null): Retype | null {
  if (question === undefined || retry !== null) return null;
  return opensRetype(question, answer) ? startRetype() : null;
}

/** Phase 23. The card answered by the phone's own judge: its banner shows at
 *  once, its response is queued. Phase 55 (spec D7): or its retype opens first. */
export function answeredState(current: QuizState, answer: CardAnswer): QuizState {
  return { ...current, answer, retype: retypeFor(current.question, answer, current.retry) };
}

/** Continue: the next card, once its response is in, or as soon as it lands.
 *  Phase 55 (spec D7): an open retype ignores it, with no banner to continue from. */
export function continued(current: QuizState): QuizState {
  if (current.retype !== null && current.retype.outcome === null) return current;
  return current.queued ? applyQueued(current, current.queued) : { ...current, advanceRequested: true };
}

/** Phase 55 (spec D7). The first character of a retype hides the right answer. */
export function retypeTypingState(current: QuizState): QuizState {
  if (current.retype === null) return current;
  const retype = retypeTyping(current.retype);
  return retype === current.retype ? current : { ...current, retype };
}

/** Phase 55 (spec D7). A retype checked on the phone; the card's answer stays
 *  the first one, which is what was sent. */
export function retypeCheckedState(current: QuizState, text: string): QuizState {
  if (current.retype === null || current.question === undefined) return current;
  const retype = retypeChecked(current.retype, current.question, text);
  return retype === current.retype ? current : { ...current, retype };
}

/** Phase 54 (spec D1, D6). The meet card tapped through: answered with `seen`,
 *  and the next card requested at once, as a skip is, so no banner shows. */
export function seenState(current: QuizState): QuizState {
  return { ...current, answer: { seen: true }, advanceRequested: true };
}

/** Phase 34 (spec D9). How an answer the phone judges goes out. `banner`: its
 *  banner shows at once and its response is queued for Continue, as before.
 *  `server`: the card waits for the response first. That is another accepted
 *  word, which holds the card for a second try whose banner must not name the
 *  saved word; and any answer after a failed check, since the server may hold
 *  a first answer already, and only its response says whether this answer is
 *  that card's second try (`settle`). A second try's banner shows at once.
 *  Phase 41 (spec D3): a typed gap word the phone calls wrong, which the server
 *  checks against the gap. */
export function answerRoute(
  state: Pick<QuizState, 'retry' | 'judging'>,
  question: Question,
  answer: { option_index: number } | { text: string },
): 'banner' | 'server' {
  if (state.retry !== null) return 'banner';
  return state.judging === 'failed' || opensRetry(question, answer) || checksFit(question, answer) ? 'server' : 'banner';
}

/** What a sent answer came back as: the answer the card shows, and the step.
 *  Phase 66b (spec D2): a judged translation's sentence check comes with it. */
export type Sent = { answer: CardAnswer; next: NextStepResponse; explanation?: ExplainResponse | null };

/** Phase 34 (spec D9). A sent answer once settled: `met` is the hold it met and
 *  resolved as that card's second try (see metHold), or null. */
export type Settled = Sent & { met: PendingRetry | null };

/** Phase 34 (spec D9). Whether an answer may be what opened the hold its own
 *  response carries. A pass or an empty text never opens one; a judged text
 *  may, and only the server knows; a clip or a board is never sent twice. */
function mayOpen(question: Question, answer: CardAnswer): boolean {
  if ('pass' in answer) return false;
  // Phase 56 (spec D2): a helped one is stored wrong, which opens none.
  if ('judged' in answer) return answer.text.trim() !== '' && answer.helped !== true;
  if ('heard' in answer || 'board' in answer) return true;
  // Phase 41 (spec D3): a word checked against the gap may be what the server held.
  return opensRetry(question, answer) || checksFit(question, answer);
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
export function landed(
  current: QuizState,
  answer: CardAnswer,
  next: NextStepResponse,
  met: PendingRetry | null,
  explanation: ExplainResponse | null = null,
): QuizState {
  const queued = queuedFrom(next);
  if (holds(queued)) return applyQueued(current, queued);
  const retry = met ?? current.retry;
  // Phase 55 (spec D7): a first typed answer sent after a failed check may open the retype too.
  return { ...current, judging: 'idle', speech: IDLE_ATTEMPT, answer, queued, retry, retype: retypeFor(current.question, answer, retry), explanation };
}

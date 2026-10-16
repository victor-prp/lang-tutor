import type {
  AnswerRecord,
  MissedQuestion,
  PendingRetry,
  Position,
  LanguageCode,
  Question,
  Score,
  SessionSource,
  SessionStatus,
} from '@lang-tutor/core/api';
import {
  SESSION_LENGTH,
  answerFits,
  evaluate,
  evaluateRetry,
  gatesScript,
  isChoice,
  isSpeaking,
  missed,
  normaliseGloss,
  pickQuestions,
  score,
  spokenVerdict,
  wrongScript,
  type AnswerInput,
  type QuestionType,
} from '@lang-tutor/core/domain';

export { SESSION_LENGTH };

export type SessionRecord = {
  user_id: string;
  questions: Question[];
  answers: AnswerRecord[];
  complete: boolean;
  completed_at: number | null;
  status: SessionStatus;
  source: SessionSource;
  /** Phase 61 (spec D5). A question-types session's chosen types no card was generated for; absent on every other session. */
  skipped_types?: SkippedType[];
};

/** Phase 61 (spec D5). A chosen question type no card could be generated for. */
export type SkippedType = { type: QuestionType; reason: 'not_generated' };

export function newSessionRecord(
  userId: string,
  pool: readonly Question[],
  rng: () => number,
): SessionRecord {
  return {
    user_id: userId,
    questions: pickQuestions(pool, SESSION_LENGTH, rng),
    answers: [],
    complete: false,
    completed_at: null,
    status: 'ready',
    source: 'seed',
  };
}

/** Phase 34 (spec D9). The answer the session is held on for its second try:
 *  the last one, while its retry is pending. Nothing is recorded after it until
 *  the retry resolves it. */
export function pendingAnswer(record: SessionRecord): AnswerRecord | undefined {
  const last = record.answers[record.answers.length - 1];
  return last?.retry_state === 'pending' ? last : undefined;
}

/** How many cards are behind the learner. A card held for its second try is
 *  still in front of them: it is the current one. */
function settled(record: SessionRecord): number {
  return record.answers.length - (pendingAnswer(record) ? 1 : 0);
}

export function currentQuestion(record: SessionRecord): Question | undefined {
  return record.questions[settled(record)];
}

export function positionOf(record: SessionRecord): Position {
  return {
    position: Math.min(settled(record) + 1, record.questions.length),
    total: record.questions.length,
  };
}

/** Phase 34 (spec D9). What the client needs to open the second try on the
 *  current card: the first answer, and which line the card shows. Another sense
 *  on a typed meaning card is another meaning; everywhere else, another word
 *  the learner saved. Null when no retry is pending. */
export function pendingRetryOf(record: SessionRecord): PendingRetry | null {
  const pending = pendingAnswer(record);
  const question = currentQuestion(record);
  if (!pending || !question) return null;
  return { answer: pending.answer_string, wording: question.type === 'typed_meaning' ? 'meaning' : 'word' };
}

/**
 * Phase 34 (spec D9). What a request for `questionId` is, decided before anything
 * is judged, so a route that pays for a model call makes it only for a fresh
 * answer or a fresh retry:
 * - `answer`: the first answer to the current card;
 * - `retry`: the one retry of the card held for it, sent with `retry`;
 * - `replay`: a request already recorded. Without `retry`, the first answer to
 *   the card answered last, pending or not, which re-opens the second try a lost
 *   response would have shown. With `retry`, that card's resolved retry;
 * - `desync`: anything else. A retry where none was pending, and any other card
 *   while one is.
 */
export type Attempt =
  | { kind: 'answer'; question: Question }
  | { kind: 'retry'; question: Question; pending: AnswerRecord }
  | { kind: 'replay'; answer: AnswerRecord; of: 'answer' | 'retry' }
  | { kind: 'desync' };

export function attemptOf(record: SessionRecord, questionId: string, retry: boolean): Attempt {
  const last = record.answers[record.answers.length - 1];
  if (last && last.question_id === questionId) {
    if (last.retry_state === 'pending') {
      return retry
        ? { kind: 'retry', question: record.questions[record.answers.length - 1], pending: last }
        : { kind: 'replay', answer: last, of: 'answer' };
    }
    if (!retry) return { kind: 'replay', answer: last, of: 'answer' };
    return last.retry_state === 'resolved' ? { kind: 'replay', answer: last, of: 'retry' } : { kind: 'desync' };
  }
  if (retry || pendingAnswer(record) || record.complete) return { kind: 'desync' };
  const current = currentQuestion(record);
  return current && current.id === questionId ? { kind: 'answer', question: current } : { kind: 'desync' };
}

/** Phase 39 (spec D10). The enrollment's languages, for the wrong-alphabet check. */
export type StepLanguages = { target: LanguageCode; learner: LanguageCode };

export type StepOutcome =
  | { status: 'invalid_question' }
  | { status: 'out_of_range' }
  | { status: 'wrong_answer_kind' }
  | { status: 'unheard' }
  // Phase 39 (spec D10): a typed answer whose letters are all in another alphabet.
  | { status: 'wrong_script' }
  | { status: 'replayed'; record: SessionRecord; justCompleted: false }
  // Phase 34 (spec D9): `recorded` says whether a new answer was appended or the
  // pending one's retry resolved, which the caller writes differently.
  | { status: 'advanced'; record: SessionRecord; justCompleted: boolean; recorded: 'answer' | 'retry' };

// Records the answer to `questionId` if it is the session's current question,
// advancing to the next one. If `questionId` is instead the question that was
// just answered by the previous call, this is a retried request: the record
// is returned unchanged rather than double-counting the answer. Any other
// `questionId` means the client and server have desynced.
//
// An option index outside the current question's options is `out_of_range`.
// That check belongs here rather than in a caller: the question knows how many
// options it has, and answering it before `evaluate` runs is what keeps a record
// carrying `answer_string: undefined` from ever being constructed. For the same
// reason a text sent to a choice, or an index sent to a typed card, is
// `wrong_answer_kind` (phase 23). A replay ignores the answer entirely: the
// record comes back unchanged, so there is nothing to judge.
//
// Phase 39 (spec D10). `languages` is the enrollment's: a typed card is checked
// against the alphabet of the language it is answered in.
//
// Phase 34 (spec D9). An answer that opens a second try is recorded pending and
// holds the session on its card: the card stays current, and the session does
// not complete on it. `retry` resolves it, judged by the same rule as the first
// answer and checked the same way. attemptOf decides which a request is.
//
// Phase 41 (spec D2). `fits`: the model found a typed cloze's first answer to
// fit its gap, so it is recorded as one of the card's alternatives. A retry is
// judged by the rule alone (ruling R3).
export function step(
  record: SessionRecord,
  questionId: string,
  answer: AnswerInput,
  { retry = false, languages, fits = false }: { retry?: boolean; languages: StepLanguages; fits?: boolean },
): StepOutcome {
  const attempt = attemptOf(record, questionId, retry);
  switch (attempt.kind) {
    case 'desync':
      return { status: 'invalid_question' };
    case 'replay':
      return { status: 'replayed', record, justCompleted: false };
    case 'answer':
    case 'retry': {
      const refused = refusal(attempt.question, answer, languages);
      if (refused) return refused;
      if (attempt.kind === 'answer') return advanced(record, [...record.answers, evaluate(fitted(attempt.question, answer, fits), answer)], 'answer');
      const { answer_string, verdict } = evaluateRetry(attempt.question, answer);
      const resolved: AnswerRecord = { ...attempt.pending, retry_state: 'resolved', retry_answer_string: answer_string, retry_verdict: verdict };
      return advanced(record, [...record.answers.slice(0, -1), resolved], 'retry');
    }
  }
}

/** Phase 41 (spec D2). A typed cloze whose first answer the model found to fit
 *  its gap: that answer is one more of its alternatives, so it is recorded as a
 *  listed word is. Any other card, or no fit, is the card as it is. */
function fitted(question: Question, answer: AnswerInput, fits: boolean): Question {
  return fits && question.type === 'cloze_typed' && 'text' in answer
    ? { ...question, alternatives: [...question.alternatives, answer.text] }
    : question;
}

/** Why `answer` cannot be recorded for `question`, or null when it can. */
function refusal(question: Question, answer: AnswerInput, languages: StepLanguages): StepOutcome | null {
  if (!answerFits(question, answer)) return { status: 'wrong_answer_kind' };
  // Phase 39 (spec D7, D10). A typed answer with letters but none in the answer
  // language's alphabet records nothing, a second try included. A spoken
  // transcript has no `text` and is never checked, and neither is a card whose
  // own right answer is in another alphabet (gatesScript, as the phone asks).
  if ('text' in answer) {
    const gate = gatesScript(question, languages.target, languages.learner);
    if (gate !== null && wrongScript(answer.text, gate)) return { status: 'wrong_script' };
  }
  // Phase 25 (spec D5). A transcript that is not the word records nothing:
  // a recogniser's reject is no evidence and never wrong (phase 20). Phase 50
  // (spec D5): unless the server scored it as sounding like the form.
  if ('heard' in answer && !('sounds_like' in answer) && isSpeaking(question) && spokenVerdict(question, answer.heard) === 'unheard') {
    return { status: 'unheard' };
  }
  if ('option_index' in answer && isChoice(question)) {
    if (answer.option_index < 0 || answer.option_index >= question.options.length) {
      return { status: 'out_of_range' };
    }
  }
  return null;
}

/** The record with `answers`, complete once every card is answered and none is
 *  held for its second try. */
function advanced(record: SessionRecord, answers: AnswerRecord[], recorded: 'answer' | 'retry'): StepOutcome {
  const complete = answers.length === record.questions.length && answers[answers.length - 1].retry_state !== 'pending';
  const updated: SessionRecord = {
    ...record,
    answers,
    complete,
    status: complete ? 'completed' : record.status,
  };
  return { status: 'advanced', record: updated, justCompleted: complete, recorded };
}

export function sessionScore(record: SessionRecord): Score {
  return score(record.questions, record.answers);
}

export function missedQuestions(record: SessionRecord): MissedQuestion[] {
  return missed(record.questions, record.answers);
}

/** An open session. Phase 43 (spec D1): at most one started and one in stock
 *  per enrollment (sessions_one_started_per_enrollment,
 *  sessions_one_stock_per_enrollment). */
export const OPEN_STATUSES: readonly SessionStatus[] = ['preparing', 'ready'];

export function isOpen(status: SessionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

/** The first session of an enrollment is the seed; every later one, after a
 *  completion, a skip or a failure, is built from the saved list. */
export function nextSource(hasAnySession: boolean): SessionSource {
  return hasAnySession ? 'list' : 'seed';
}

/** A uniform shuffle under the injected rng. A copy: the caller's array is left alone. */
export function shuffle<T>(entries: readonly T[], rng: () => number): T[] {
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/** A session row as the use cases read it before changing its status. */
export type SessionState = {
  id: string;
  userId: string;
  enrollmentId: string;
  status: SessionStatus;
  source: SessionSource;
};

/** Phase 43 (spec D1). What a session is built for: whether the device has a
 *  voice for the target (phase 24) and whether it can record (phase 25). */
export type Devices = { listening: boolean; speaking: boolean };

/** An enrollment's session, as the home screen needs it. `total` is the
 *  number of questions it holds: 0 while it is still preparing. */
export type SessionSummary = {
  id: string;
  status: SessionStatus;
  source: SessionSource;
  answered: number;
  total: number;
};

/** Phase 31. A saved gloss as a session picks it: its key, and the form it was saved from.
 *  Phase 35: and when it was saved, a sortable UTC timestamp (newest new words first, D5).
 *  Phase 39 (spec D3, D4): its lexeme and lemma, the lowercased form it was saved from, and
 *  the dictionary's order of this meaning: the saved variant's entry_rank, then the lowest
 *  rank among its renderings on that variant in the learner's language (0 if none). */
export type SavedGloss = {
  glossId: string;
  key: string;
  variantId: string;
  savedAt: string;
  lexemeId: string;
  lemma: string;
  form: string;
  order: [number, number];
  /** Phase 46 (spec D3). When a refresh first saw this gloss known; null if never. */
  knownAt: string | null;
};

/** Phase 31 (spec D12). One rendering of one member of a gloss, by one form, with
 *  the citation form the model gave it. */
export type GlossRendering = { glossId: string; senseId: string; variantId: string; form: string; gloss: string; rank: number };

/**
 * Spec D12. The renderings a session may ask for a gloss: every form of every
 * member whose own citation form is the gloss's key, and the saved form always,
 * so a learner is never asked a word that was never on their card (a drifted or
 * misspelt citation form) and always may be asked the one they saved. Ordered by
 * variant and sense, so a seeded rng picks reproducibly.
 */
export function askableRenderings(gloss: Omit<SavedGloss, 'savedAt'>, renderings: readonly GlossRendering[]): GlossRendering[] {
  const key = normaliseGloss(gloss.key);
  return renderings
    .filter(
      (rendering) =>
        rendering.glossId === gloss.glossId && (normaliseGloss(rendering.gloss) === key || rendering.variantId === gloss.variantId),
    )
    .sort((a, b) => a.variantId.localeCompare(b.variantId) || a.senseId.localeCompare(b.senseId));
}

/** One of `options`, uniformly under the injected rng; undefined when there is none. */
export function pickRendering(options: readonly GlossRendering[], rng: () => number): GlossRendering | undefined {
  return options[Math.floor(rng() * options.length)];
}

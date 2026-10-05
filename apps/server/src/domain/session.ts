import type { AnswerRecord, MissedQuestion, Position, Question, Score, SessionSource, SessionStatus } from '@lang-tutor/core/api';
import { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from '@lang-tutor/core/domain';

export { SESSION_LENGTH };

export type SessionRecord = {
  user_id: string;
  questions: Question[];
  answers: AnswerRecord[];
  complete: boolean;
  completed_at: number | null;
  status: SessionStatus;
  source: SessionSource;
};

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

export function currentQuestion(record: SessionRecord): Question | undefined {
  return record.questions[record.answers.length];
}

export function positionOf(record: SessionRecord): Position {
  return {
    position: Math.min(record.answers.length + 1, record.questions.length),
    total: record.questions.length,
  };
}

export type StepOutcome =
  | { status: 'invalid_question' }
  | { status: 'out_of_range' }
  | { status: 'advanced' | 'replayed'; record: SessionRecord; justCompleted: boolean };

// Records the answer to `questionId` if it is the session's current question,
// advancing to the next one. If `questionId` is instead the question that was
// just answered by the previous call, this is a retried request: the record
// is returned unchanged rather than double-counting the answer. Any other
// `questionId` means the client and server have desynced.
//
// An `optionIndex` outside the current question's options is `out_of_range`.
// That check belongs here rather than in a caller: the question knows how many
// options it has, and answering it before `evaluate` runs is what keeps a record
// carrying `answer_string: undefined` from ever being constructed.
export function step(record: SessionRecord, questionId: string, optionIndex: number): StepOutcome {
  if (record.complete) {
    const lastQuestion = record.questions[record.questions.length - 1];
    return questionId === lastQuestion.id
      ? { status: 'replayed', record, justCompleted: false }
      : { status: 'invalid_question' };
  }

  const expected = currentQuestion(record);
  if (expected && questionId === expected.id) {
    if (optionIndex < 0 || optionIndex >= expected.options.length) {
      return { status: 'out_of_range' };
    }
    const answers = [...record.answers, evaluate(expected, optionIndex)];
    const complete = answers.length === record.questions.length;
    const updated: SessionRecord = {
      ...record,
      answers,
      complete,
      status: complete ? 'completed' : record.status,
    };
    return { status: 'advanced', record: updated, justCompleted: complete };
  }

  const previouslyAnswered =
    record.answers.length > 0 ? record.questions[record.answers.length - 1] : undefined;
  if (previouslyAnswered && questionId === previouslyAnswered.id) {
    return { status: 'replayed', record, justCompleted: false };
  }

  return { status: 'invalid_question' };
}

export function sessionScore(record: SessionRecord): Score {
  return score(record.questions, record.answers);
}

export function missedQuestions(record: SessionRecord): MissedQuestion[] {
  return missed(record.questions, record.answers);
}

/** A session that blocks the next one: at most one per enrollment
 *  (sessions_one_open_per_enrollment). */
export const OPEN_STATUSES: readonly SessionStatus[] = ['preparing', 'ready'];
/** What the home screen shows as the current session. A failed one stays
 *  visible until the next create, so a failure is never silent. */
export const CURRENT_STATUSES: readonly SessionStatus[] = ['preparing', 'ready', 'failed'];

export function isOpen(status: SessionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isCurrent(status: SessionStatus): boolean {
  return CURRENT_STATUSES.includes(status);
}

/** The first session of an enrollment is the seed; every later one, after a
 *  completion, a skip or a failure, is built from the saved list. */
export function nextSource(hasAnySession: boolean): SessionSource {
  return hasAnySession ? 'list' : 'seed';
}

/** Up to `max` entries, uniformly at random under the injected rng, without
 *  repeats. A copy: the caller's array is left alone. */
export function pickSenses<T>(entries: readonly T[], max: number, rng: () => number): T[] {
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, max);
}

/** A session row as the use cases read it before changing its status. */
export type SessionState = {
  id: string;
  userId: string;
  enrollmentId: string;
  status: SessionStatus;
  source: SessionSource;
};

/** An enrollment's newest session, as the home screen needs it. `total` is the
 *  number of questions it holds: 0 while it is still preparing. */
export type SessionSummary = {
  id: string;
  status: SessionStatus;
  source: SessionSource;
  answered: number;
  total: number;
};

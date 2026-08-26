import type { AnswerRecord, MissedQuestion, Position, Question, Score } from '@lang-tutor/core/api';
import { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from '@lang-tutor/core/domain';

export { SESSION_LENGTH };

export type SessionRecord = {
  user_id: string;
  questions: Question[];
  answers: AnswerRecord[];
  complete: boolean;
  completed_at: number | null;
};

export function newSessionRecord(
  userId: string,
  pool: readonly Question[],
  rng: () => number = Math.random,
): SessionRecord {
  return {
    user_id: userId,
    questions: pickQuestions(pool, SESSION_LENGTH, rng),
    answers: [],
    complete: false,
    completed_at: null,
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
  | { status: 'advanced' | 'replayed'; record: SessionRecord; justCompleted: boolean };

// Records the answer to `questionId` if it is the session's current question,
// advancing to the next one. If `questionId` is instead the question that was
// just answered by the previous call, this is a retried request: the record
// is returned unchanged rather than double-counting the answer. Any other
// `questionId` means the client and server have desynced.
export function step(record: SessionRecord, questionId: string, optionIndex: number): StepOutcome {
  if (record.complete) {
    const lastQuestion = record.questions[record.questions.length - 1];
    return questionId === lastQuestion.id
      ? { status: 'replayed', record, justCompleted: false }
      : { status: 'invalid_question' };
  }

  const expected = currentQuestion(record);
  if (expected && questionId === expected.id) {
    const answers = [...record.answers, evaluate(expected, optionIndex)];
    const complete = answers.length === record.questions.length;
    const updated: SessionRecord = { ...record, answers, complete };
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

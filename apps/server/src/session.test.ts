import { describe, expect, it } from '@jest/globals';
import type { AnswerRecord, Question } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import {
  currentQuestion,
  missedQuestions,
  newSessionRecord,
  positionOf,
  sessionScore,
  step,
  type SessionRecord,
} from './session';

function makeQuestion(n: number): Question {
  return {
    id: `q${n}`,
    type: 'multiple_choice',
    vocab_entry_id: `v${n}`,
    question: `word ${n}`,
    options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
    correct_option: 0,
  };
}

const POOL: Question[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

function makeRecord(questions: Question[], answers: AnswerRecord[] = []): SessionRecord {
  return {
    user_id: 'u1',
    questions,
    answers,
    complete: answers.length === questions.length,
    completed_at: null,
  };
}

describe('newSessionRecord', () => {
  it('starts with no answers and the first question current', () => {
    const record = newSessionRecord('u1', POOL, () => 0.5);
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
    expect(record.complete).toBe(false);
    expect(record.completed_at).toBeNull();
    expect(record.user_id).toBe('u1');
    expect(currentQuestion(record)).toBe(record.questions[0]);
    expect(positionOf(record)).toEqual({ position: 1, total: SESSION_LENGTH });
  });
});

describe('positionOf', () => {
  it('reports 1-based position, capped at total once complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    expect(positionOf(done)).toEqual({ position: 1, total: 1 });
  });
});

describe('step', () => {
  it('records a fresh answer and advances to the next question', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const outcome = step(makeRecord([q0, q1]), q0.id, q0.correct_option);
    expect(outcome.status).toBe('advanced');
    if (outcome.status !== 'advanced') throw new Error('unreachable');
    expect(outcome.record.answers).toHaveLength(1);
    expect(outcome.record.answers[0]).toEqual({
      question_id: q0.id,
      is_correct: true,
      answer_string: q0.options[q0.correct_option],
    });
    expect(outcome.record.complete).toBe(false);
    expect(outcome.justCompleted).toBe(false);
    expect(currentQuestion(outcome.record)).toBe(q1);
  });

  it('marks the record complete on the last question and reports justCompleted', () => {
    const q0 = makeQuestion(0);
    const outcome = step(makeRecord([q0]), q0.id, q0.correct_option);
    expect(outcome.status).toBe('advanced');
    if (outcome.status !== 'advanced') throw new Error('unreachable');
    expect(outcome.record.complete).toBe(true);
    expect(outcome.justCompleted).toBe(true);
    expect(currentQuestion(outcome.record)).toBeUndefined();
  });

  it('replays the same outcome when retried with the question that was just answered', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const answered = makeRecord(
      [q0, q1],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    const outcome = step(answered, q0.id, q0.correct_option);
    expect(outcome).toEqual({ status: 'replayed', record: answered, justCompleted: false });
  });

  it('replays the completion outcome when retried after the session is already complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    expect(done.complete).toBe(true);
    const outcome = step(done, q0.id, q0.correct_option);
    expect(outcome).toEqual({ status: 'replayed', record: done, justCompleted: false });
  });

  it('rejects a question_id that matches neither the current nor the just-answered question', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const outcome = step(makeRecord([q0, q1]), 'not-a-real-id', 0);
    expect(outcome).toEqual({ status: 'invalid_question' });
  });

  it('rejects a stale question_id once the session is complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    const outcome = step(done, 'not-a-real-id', 0);
    expect(outcome).toEqual({ status: 'invalid_question' });
  });
});

describe('sessionScore and missedQuestions', () => {
  it('delegates to the shared domain rules', () => {
    const [q0, q1, q2] = [makeQuestion(0), makeQuestion(1), makeQuestion(2)];
    const record = makeRecord(
      [q0, q1, q2],
      [
        { question_id: q0.id, is_correct: true, answer_string: q0.options[0] },
        { question_id: q1.id, is_correct: false, answer_string: q1.options[1] },
        { question_id: q2.id, is_correct: true, answer_string: q2.options[0] },
      ],
    );
    expect(sessionScore(record)).toEqual({ correct: 2, total: 3 });
    expect(missedQuestions(record)).toEqual([
      { question: q1, correct_answer: q1.options[q1.correct_option] },
    ]);
  });
});

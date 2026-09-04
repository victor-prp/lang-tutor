import { describe, expect, it } from '@jest/globals';

import type { Question } from '../api/types';
import { seededRng } from '../utils/rng';
import { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from './quiz';

function makeQuestion(n: number): Question {
  return {
    id: `q${n}`,
    type: 'multiple_choice',
    vocab_term_id: `v${n}`,
    question: `word ${n}`,
    options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
    correct_option: 0,
  };
}

const POOL: Question[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

describe('pickQuestions', () => {
  it('returns exactly the requested number of questions', () => {
    expect(pickQuestions(POOL, SESSION_LENGTH, seededRng(1))).toHaveLength(SESSION_LENGTH);
  });

  it('never repeats a question', () => {
    const ids = pickQuestions(POOL, SESSION_LENGTH, seededRng(2)).map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps correct_option pointing at the correct answer after shuffling options', () => {
    for (const question of pickQuestions(POOL, SESSION_LENGTH, seededRng(3))) {
      const original = POOL.find((item) => item.id === question.id)!;
      expect(question.options[question.correct_option]).toBe(
        original.options[original.correct_option],
      );
      expect([...question.options].sort()).toEqual([...original.options].sort());
    }
  });

  it('throws when the pool is smaller than the requested count', () => {
    expect(() => pickQuestions(POOL.slice(0, 3), SESSION_LENGTH, seededRng(4))).toThrow(
      'pool has 3 questions, need at least 10',
    );
  });

  it('does not mutate the pool', () => {
    const before = JSON.stringify(POOL);
    pickQuestions(POOL, SESSION_LENGTH, seededRng(5));
    expect(JSON.stringify(POOL)).toBe(before);
  });
});

describe('evaluate', () => {
  it('records a correct answer with the chosen option text', () => {
    const question = makeQuestion(1);
    expect(evaluate(question, question.correct_option)).toEqual({
      question_id: 'q1',
      is_correct: true,
      answer_string: 'a1',
    });
  });

  it('records answer_string for a wrong answer too', () => {
    const question = makeQuestion(2);
    expect(evaluate(question, 3)).toEqual({
      question_id: 'q2',
      is_correct: false,
      answer_string: 'd2',
    });
  });
});

describe('score', () => {
  it('counts correct answers against the number of questions asked', () => {
    const questions = [makeQuestion(1), makeQuestion(2), makeQuestion(3)];
    const answers = [
      evaluate(questions[0], 0),
      evaluate(questions[1], 1),
      evaluate(questions[2], 0),
    ];
    expect(score(questions, answers)).toEqual({ correct: 2, total: 3 });
  });

  it('reports zero correct for an unanswered set', () => {
    expect(score([makeQuestion(1), makeQuestion(2)], [])).toEqual({ correct: 0, total: 2 });
  });
});

describe('missed', () => {
  it('lists only wrong answers, with the correct answer text', () => {
    const questions = [makeQuestion(1), makeQuestion(2), makeQuestion(3)];
    const answers = [
      evaluate(questions[0], 0),
      evaluate(questions[1], 2),
      evaluate(questions[2], 0),
    ];
    expect(missed(questions, answers)).toEqual([
      { question: questions[1], correct_answer: 'a2' },
    ]);
  });

  it('returns an empty list for a perfect score', () => {
    const questions = [makeQuestion(1), makeQuestion(2)];
    const answers = questions.map((question) => evaluate(question, question.correct_option));
    expect(missed(questions, answers)).toEqual([]);
  });

  it('ignores answers whose question is not in the set', () => {
    const questions = [makeQuestion(1)];
    expect(missed(questions, [evaluate(makeQuestion(99), 1)])).toEqual([]);
  });
});

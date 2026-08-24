import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';

import {
  SESSION_LENGTH,
  advance,
  answer,
  createSession,
  currentQuestion,
  isAnswered,
  isComplete,
  missedQuestions,
  progress,
  sessionScore,
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

describe('createSession', () => {
  it('starts unanswered on the first question', () => {
    const state = createSession(POOL, SESSION_LENGTH, () => 0.5);
    expect(state.questions).toHaveLength(SESSION_LENGTH);
    expect(state.index).toBe(0);
    expect(state.answers).toEqual([]);
    expect(isAnswered(state)).toBe(false);
    expect(progress(state)).toEqual({ position: 1, total: 10 });
  });
});

describe('answer', () => {
  it('records the answer without advancing', () => {
    const state = createSession(POOL, 2, () => 0.5);
    const question = currentQuestion(state)!;
    const next = answer(state, question.correct_option);
    expect(next.answers).toHaveLength(1);
    expect(next.answers[0].is_correct).toBe(true);
    expect(next.selected_option).toBe(question.correct_option);
    expect(next.index).toBe(0);
  });

  it('ignores a second answer to the same question', () => {
    const state = createSession(POOL, 2, () => 0.5);
    const once = answer(state, 0);
    expect(answer(once, 1)).toBe(once);
  });
});

describe('advance', () => {
  it('moves on and clears the selection', () => {
    const state = advance(answer(createSession(POOL, 2, () => 0.5), 0));
    expect(state.index).toBe(1);
    expect(state.selected_option).toBeNull();
  });

  it('does nothing while unanswered', () => {
    const state = createSession(POOL, 2, () => 0.5);
    expect(advance(state)).toBe(state);
  });

  it('reaches a terminal state after the last question', () => {
    let state = createSession(POOL, 2, () => 0.5);
    state = advance(answer(state, 0));
    expect(isComplete(state)).toBe(false);
    state = advance(answer(state, 0));
    expect(isComplete(state)).toBe(true);
    expect(currentQuestion(state)).toBeUndefined();
  });
});

describe('sessionScore and missedQuestions', () => {
  it('delegates scoring to the shared domain rules', () => {
    let state = createSession(POOL, 3, () => 0.5);
    const first = currentQuestion(state)!;
    state = advance(answer(state, first.correct_option));
    const second = currentQuestion(state)!;
    const wrong = (second.correct_option + 1) % second.options.length;
    state = advance(answer(state, wrong));
    const third = currentQuestion(state)!;
    state = advance(answer(state, third.correct_option));

    expect(sessionScore(state)).toEqual({ correct: 2, total: 3 });
    expect(missedQuestions(state)).toEqual([
      { question: second, correct_answer: second.options[second.correct_option] },
    ]);
  });
});

import type { AnswerRecord, MissedQuestion, Question, Score } from '@lang-tutor/core/api';
import { SESSION_LENGTH, evaluate, missed, pickQuestions, score } from '@lang-tutor/core/domain';

// Re-exported so screens have a single import for it rather than reaching past
// this module into core.
export { SESSION_LENGTH };

export type SessionState = {
  questions: Question[];
  index: number;
  answers: AnswerRecord[];
  /** null while the current question is unanswered. */
  selected_option: number | null;
};

// In phase 2 this stops calling pickQuestions and starts calling the API. The
// cursor, the selectors and all four screens are untouched by that change.
export function createSession(
  pool: readonly Question[],
  count: number = SESSION_LENGTH,
  rng: () => number = Math.random,
): SessionState {
  return {
    questions: pickQuestions(pool, count, rng),
    index: 0,
    answers: [],
    selected_option: null,
  };
}

export function currentQuestion(state: SessionState): Question | undefined {
  return state.questions[state.index];
}

export function isComplete(state: SessionState): boolean {
  return state.index >= state.questions.length;
}

export function isAnswered(state: SessionState): boolean {
  return state.selected_option !== null;
}

export function answer(state: SessionState, optionIndex: number): SessionState {
  const question = currentQuestion(state);
  if (!question || isAnswered(state)) return state;
  return {
    ...state,
    selected_option: optionIndex,
    answers: [...state.answers, evaluate(question, optionIndex)],
  };
}

export function advance(state: SessionState): SessionState {
  if (!isAnswered(state)) return state;
  return { ...state, index: state.index + 1, selected_option: null };
}

export function progress(state: SessionState): { position: number; total: number } {
  return {
    position: Math.min(state.index + 1, state.questions.length),
    total: state.questions.length,
  };
}

export function sessionScore(state: SessionState): Score {
  return score(state.questions, state.answers);
}

export function missedQuestions(state: SessionState): MissedQuestion[] {
  return missed(state.questions, state.answers);
}

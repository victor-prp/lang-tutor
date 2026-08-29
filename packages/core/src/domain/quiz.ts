import type { AnswerRecord, MissedQuestion, Question, Score } from '../api/types';
import { shuffle } from '../utils/shuffle';

export const SESSION_LENGTH = 10;

function shuffleOptions(question: Question, rng: () => number): Question {
  const correct = question.options[question.correct_option];
  const options = shuffle(question.options, rng);
  return { ...question, options, correct_option: options.indexOf(correct) };
}

// No default arguments: a server must not inherit Math.random by accident. The
// app's createSession wrapper supplies the client-side defaults.
export function pickQuestions(
  pool: readonly Question[],
  count: number,
  rng: () => number,
): Question[] {
  if (pool.length < count) {
    throw new Error(`pool has ${pool.length} questions, need at least ${count}`);
  }
  return shuffle(pool, rng)
    .slice(0, count)
    .map((question) => shuffleOptions(question, rng));
}

export function evaluate(question: Question, optionIndex: number): AnswerRecord {
  return {
    question_id: question.id,
    is_correct: optionIndex === question.correct_option,
    answer_string: question.options[optionIndex],
  };
}

export function score(questions: readonly Question[], answers: readonly AnswerRecord[]): Score {
  return {
    correct: answers.filter((record) => record.is_correct).length,
    total: questions.length,
  };
}

export function missed(
  questions: readonly Question[],
  answers: readonly AnswerRecord[],
): MissedQuestion[] {
  return answers
    .filter((record) => !record.is_correct)
    .flatMap((record) => {
      const question = questions.find((item) => item.id === record.question_id);
      return question
        ? [{ question, correct_answer: question.options[question.correct_option] }]
        : [];
    });
}

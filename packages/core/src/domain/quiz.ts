import type {
  AnswerRecord,
  MissedQuestion,
  MultipleChoiceQuestion,
  Question,
  ReverseChoiceQuestion,
  Score,
} from '../api/types';
import { shuffle } from '../utils/shuffle';
import { judgeTyped } from './typed';

export const SESSION_LENGTH = 10;

/** Phase 23. Derived here rather than in api/types.ts, which holds z.infers only. */
export type QuestionType = Question['type'];

/** Phase 23. A choice is answered by index, a typed card by its text. */
export type AnswerInput = { option_index: number } | { text: string };

export type ChoiceQuestion = MultipleChoiceQuestion | ReverseChoiceQuestion;

export function isChoice(question: Question): question is ChoiceQuestion {
  return question.type !== 'typed_translation';
}

/** Whether `answer` is the kind `question` takes. */
export function answerFits(question: Question, answer: AnswerInput): boolean {
  return isChoice(question) ? 'option_index' in answer : 'text' in answer;
}

/** What the learner should have answered, as the feedback and the missed list show it. */
export function rightAnswer(question: Question): string {
  return isChoice(question) ? question.options[question.correct_option] : question.answer;
}

/** A choice's options in a new order. A typed card has none and comes back as it is. */
export function shuffleOptions(question: Question, rng: () => number): Question {
  if (!isChoice(question)) return question;
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

// Callers check answerFits, and an option's range, first: the session's step
// owns those outcomes, so here a mismatch is a programming error.
export function evaluate(question: Question, answer: AnswerInput): AnswerRecord {
  if (isChoice(question) && 'option_index' in answer) {
    return {
      question_id: question.id,
      is_correct: answer.option_index === question.correct_option,
      answer_string: question.options[answer.option_index],
    };
  }
  if (!isChoice(question) && 'text' in answer) {
    const verdict = judgeTyped(question, answer.text);
    return {
      question_id: question.id,
      is_correct: verdict !== 'wrong',
      answer_string: answer.text,
      verdict,
    };
  }
  throw new Error(`the answer does not fit a ${question.type} question`);
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
      return question ? [{ question, correct_answer: rightAnswer(question) }] : [];
    });
}

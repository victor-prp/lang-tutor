import type {
  AnswerRecord,
  ListenChoiceQuestion,
  MatchingQuestion,
  MissedQuestion,
  MultipleChoiceQuestion,
  Question,
  ReverseChoiceQuestion,
  Score,
  TypedVerdict,
} from '../api/types';
import { shuffle } from '../utils/shuffle';
import { judgeTiles, judgeTyped } from './typed';

export const SESSION_LENGTH = 10;

/** Phase 23. Derived here rather than in api/types.ts, which holds z.infers only. */
export type QuestionType = Question['type'];

/** Phase 23. A choice is answered by index, a typed card by its text. */
export type AnswerInput = { option_index: number } | { text: string };

export type ChoiceQuestion = MultipleChoiceQuestion | ReverseChoiceQuestion | ListenChoiceQuestion | MatchingQuestion;
/** Phase 24. A question answered by text: typed, heard, or built from tiles. */
type TextQuestion = Exclude<Question, ChoiceQuestion>;

export function isChoice(question: Question): question is ChoiceQuestion {
  switch (question.type) {
    case 'multiple_choice':
    case 'reverse_choice':
    case 'listen_choice':
    case 'matching':
      return true;
    case 'typed_translation':
    case 'dictation':
    case 'letter_tiles':
      return false;
  }
}

/** Whether `answer` is the kind `question` takes. */
export function answerFits(question: Question, answer: AnswerInput): boolean {
  return isChoice(question) ? 'option_index' in answer : 'text' in answer;
}

/** What the learner should have answered, as the feedback and the missed list show it. */
export function rightAnswer(question: Question): string {
  if (isChoice(question)) return question.options[question.correct_option];
  return question.type === 'dictation' ? question.question : question.answer;
}

/** A choice's options in a new order. A text card has none and comes back as
 *  it is, and so does a board word: its board shares one order, which
 *  shuffleSession gives it. */
export function shuffleOptions(question: Question, rng: () => number): Question {
  if (!isChoice(question) || question.type === 'matching') return question;
  const correct = question.options[question.correct_option];
  const options = shuffle(question.options, rng);
  return { ...question, options, correct_option: options.indexOf(correct) };
}

/**
 * Phase 24 (spec D10). A list session's shown orders: each choice shuffled on
 * its own, and a board's words once, together, so all of them show one order
 * and the board's correct options follow it. A board's words share their
 * canonical options (repo/questions), which is what lets one order fit all.
 */
export function shuffleSession(questions: readonly Question[], rng: () => number): Question[] {
  let boardOrder: string[] | null = null;
  return questions.map((question) => {
    if (question.type !== 'matching') return shuffleOptions(question, rng);
    const order = (boardOrder ??= shuffle(question.options, rng));
    const at = (index: number) => order.indexOf(question.options[index]);
    return {
      ...question,
      options: order,
      correct_option: at(question.correct_option),
      board: { ...question.board, correct_options: question.board.correct_options.map(at) },
    };
  });
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

function verdictFor(question: TextQuestion, text: string): TypedVerdict {
  switch (question.type) {
    case 'typed_translation':
      return judgeTyped(question, text);
    case 'dictation':
      // Spec D7: what was said, and nothing else — not its lemma, not a synonym.
      return judgeTyped({ answer: question.question, lemma: question.question, alternatives: [] }, text);
    case 'letter_tiles':
      return judgeTiles(question.answer, text);
  }
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
    const verdict = verdictFor(question, answer.text);
    return { question_id: question.id, is_correct: verdict !== 'wrong', answer_string: answer.text, verdict };
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

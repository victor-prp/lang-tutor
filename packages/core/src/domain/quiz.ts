import type {
  AnswerRecord,
  AnswerVerdict,
  ListenChoiceQuestion,
  MatchingQuestion,
  MissedQuestion,
  MultipleChoiceQuestion,
  Question,
  ReadAloudQuestion,
  ReverseChoiceQuestion,
  SayTranslationQuestion,
  Score,
  SpeechVerdict,
  TypedVerdict,
} from '../api/types';
import { shuffle } from '../utils/shuffle';
import { judgeSpoken, type SpokenTarget } from './spoken';
import { judgeTiles, judgeTyped } from './typed';

export const SESSION_LENGTH = 10;

/** Phase 23. Derived here rather than in api/types.ts, which holds z.infers only. */
export type QuestionType = Question['type'];

/** Phase 23. A choice is answered by index, a typed card by its text. Phase 25:
 *  a speaking card by a transcript, which only the server builds from the audio
 *  it judged, or by a pass (spec D5). */
export type AnswerInput =
  | { option_index: number }
  | { text: string }
  | { heard: string }
  | { pass: 'skip' | 'show_answer' };

export type ChoiceQuestion = MultipleChoiceQuestion | ReverseChoiceQuestion | ListenChoiceQuestion | MatchingQuestion;
/** Phase 25. The cards answered by voice. */
export type SpeakingQuestion = ReadAloudQuestion | SayTranslationQuestion;
/** Phase 24. A question answered by text: typed, heard, or built from tiles. */
type TextQuestion = Exclude<Question, ChoiceQuestion | SpeakingQuestion>;

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
    case 'read_aloud':
    case 'say_translation':
      return false;
  }
}

export function isSpeaking(question: Question): question is SpeakingQuestion {
  return question.type === 'read_aloud' || question.type === 'say_translation';
}

/** Whether `answer` is the kind `question` takes. A read-aloud card has no
 *  "show the answer": its word is on the screen. */
export function answerFits(question: Question, answer: AnswerInput): boolean {
  if (isChoice(question)) return 'option_index' in answer;
  if (question.type === 'read_aloud') return 'heard' in answer || ('pass' in answer && answer.pass === 'skip');
  if (question.type === 'say_translation') return 'heard' in answer || 'pass' in answer || 'text' in answer;
  return 'text' in answer;
}

/** What the learner should have answered, as the feedback and the missed list show it. */
export function rightAnswer(question: Question): string {
  if (isChoice(question)) return question.options[question.correct_option];
  return question.type === 'dictation' || question.type === 'read_aloud' ? question.question : question.answer;
}

/** Phase 25 (spec D6). What a speaking card's transcript is judged against:
 *  read aloud, the form shown; say the translation, the form or its lemma, and
 *  the alternatives. */
export function spokenTarget(question: SpeakingQuestion): SpokenTarget {
  return question.type === 'read_aloud'
    ? { forms: [question.question], alternatives: [] }
    : { forms: [question.answer, question.lemma], alternatives: question.alternatives };
}

export function spokenVerdict(question: SpeakingQuestion, heard: string): SpeechVerdict {
  return judgeSpoken(spokenTarget(question), heard);
}

/** Phase 25 (spec D9). Whether a stored verdict counts as right. A skip is
 *  not right, and score leaves it out of the total. */
export function verdictCorrect(verdict: AnswerVerdict): boolean {
  return verdict !== 'wrong' && verdict !== 'gave_up' && verdict !== 'skipped';
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

function verdictFor(question: TextQuestion | SayTranslationQuestion, text: string): TypedVerdict {
  switch (question.type) {
    case 'typed_translation':
    case 'say_translation':
      return judgeTyped(question, text);
    case 'dictation':
      // Spec D7: what was said, and nothing else — not its lemma, not a synonym.
      return judgeTyped({ answer: question.question, lemma: question.question, alternatives: [] }, text);
    case 'letter_tiles':
      return judgeTiles(question.answer, text);
  }
}

// answers_typed_text_length: a transcript is stored as the text of its answer.
const MAX_ANSWER_TEXT = 100;

// Callers check answerFits, and an option's range, first: the session's step
// owns those outcomes, so here a mismatch is a programming error. So is an
// unheard transcript, which step refuses before it gets here (spec D5).
export function evaluate(question: Question, answer: AnswerInput): AnswerRecord {
  if (isChoice(question) && 'option_index' in answer) {
    return {
      question_id: question.id,
      is_correct: answer.option_index === question.correct_option,
      answer_string: question.options[answer.option_index],
    };
  }
  if (isSpeaking(question) && 'heard' in answer) {
    const verdict = spokenVerdict(question, answer.heard);
    if (verdict === 'unheard') throw new Error('an unheard transcript is never recorded (spec D5)');
    return { question_id: question.id, is_correct: true, answer_string: answer.heard.slice(0, MAX_ANSWER_TEXT), verdict };
  }
  if (isSpeaking(question) && 'pass' in answer) {
    const verdict = answer.pass === 'skip' ? 'skipped' : 'gave_up';
    return { question_id: question.id, is_correct: false, answer_string: '', verdict };
  }
  if (!isChoice(question) && question.type !== 'read_aloud' && 'text' in answer) {
    const verdict = verdictFor(question, answer.text);
    return { question_id: question.id, is_correct: verdictCorrect(verdict), answer_string: answer.text, verdict };
  }
  throw new Error(`the answer does not fit a ${question.type} question`);
}

/** Phase 25 (spec D9). A skipped card is not in the total: a skip is not a failure. */
export function score(questions: readonly Question[], answers: readonly AnswerRecord[]): Score {
  return {
    correct: answers.filter((record) => record.is_correct).length,
    total: questions.length - answers.filter((record) => record.verdict === 'skipped').length,
  };
}

export function missed(
  questions: readonly Question[],
  answers: readonly AnswerRecord[],
): MissedQuestion[] {
  return answers
    .filter((record) => !record.is_correct && record.verdict !== 'skipped')
    .flatMap((record) => {
      const question = questions.find((item) => item.id === record.question_id);
      return question ? [{ question, correct_answer: rightAnswer(question) }] : [];
    });
}

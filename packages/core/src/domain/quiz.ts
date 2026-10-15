import type {
  AnswerRecord,
  AnswerVerdict,
  ClozeChoiceQuestion,
  ListenChoiceQuestion,
  MatchingQuestion,
  MeetQuestion,
  MissedQuestion,
  MultipleChoiceQuestion,
  NewMeaningQuestion,
  Question,
  ReadAloudQuestion,
  ReverseChoiceQuestion,
  SayTranslationQuestion,
  Score,
  SentenceTranslationQuestion,
  SpeechVerdict,
  TypedMeaningQuestion,
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
  // Phase 50 (spec D5). A transcript the server scored as sounding like the
  // card's form, which it names. Only the server builds it: the next-step
  // schema has no `sounds_like` field.
  | { heard: string; sounds_like: string }
  | { pass: 'skip' | 'show_answer' }
  // Phase 27 (spec D3). A text the server judged, by rule or by a model call.
  // Only the server builds it: the next-step schema has no `judged` field.
  | { text: string; judged: TypedVerdict }
  // Phase 54 (spec D6). A meet card, tapped through. It takes no other answer.
  | { seen: true };

export type ChoiceQuestion = MultipleChoiceQuestion | NewMeaningQuestion | ReverseChoiceQuestion | ListenChoiceQuestion | MatchingQuestion | ClozeChoiceQuestion;
/** Phase 25. The cards answered by voice. */
export type SpeakingQuestion = ReadAloudQuestion | SayTranslationQuestion;
/** Phase 24. A question answered by text: typed, heard, or built from tiles. */
/** Phase 27 (spec D3). The cards whose text answer the server judges. */
export type JudgedQuestion = TypedMeaningQuestion | SentenceTranslationQuestion;
type TextQuestion = Exclude<Question, ChoiceQuestion | SpeakingQuestion | JudgedQuestion | MeetQuestion>;

export function isChoice(question: Question): question is ChoiceQuestion {
  switch (question.type) {
    case 'multiple_choice':
    case 'new_meaning':
    case 'reverse_choice':
    case 'listen_choice':
    case 'matching':
    case 'cloze_choice':
      return true;
    case 'typed_translation':
    case 'dictation':
    case 'letter_tiles':
    case 'read_aloud':
    case 'meet':
    case 'say_translation':
    case 'typed_meaning':
    case 'cloze_typed':
    case 'sentence_translation':
      return false;
  }
}

export function isSpeaking(question: Question): question is SpeakingQuestion {
  return question.type === 'read_aloud' || question.type === 'say_translation';
}

/** Phase 27 (spec D3). The cards whose text answer the server judges. */
export function isJudged(question: Question): question is JudgedQuestion {
  return question.type === 'typed_meaning' || question.type === 'sentence_translation';
}

/** Whether `answer` is the kind `question` takes. A read-aloud card has no
 *  "show the answer": its word is on the screen. */
export function answerFits(question: Question, answer: AnswerInput): boolean {
  // Phase 54 (spec D6). A meet card takes `seen` and nothing else; no other card takes it.
  if (question.type === 'meet') return 'seen' in answer;
  if ('seen' in answer) return false;
  if (isChoice(question)) return 'option_index' in answer;
  if (question.type === 'read_aloud') return 'heard' in answer || ('pass' in answer && answer.pass === 'skip');
  if (question.type === 'say_translation') return 'heard' in answer || 'pass' in answer || ('text' in answer && !('judged' in answer));
  if (isJudged(question)) return 'text' in answer && 'judged' in answer;
  return 'text' in answer && !('judged' in answer);
}

/** What the learner should have answered, as the feedback and the missed list show it. */
export function rightAnswer(question: Question): string {
  if (isChoice(question)) return question.options[question.correct_option];
  if (question.type === 'typed_meaning') return question.meaning;
  if (question.type === 'sentence_translation') return question.sentence;
  return question.type === 'dictation' || question.type === 'read_aloud' || question.type === 'meet' ? question.question : question.answer;
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
 *  not right, and score leaves it out of the total. Phase 54 (spec D6): nor is
 *  a meet card's `seen`. */
export function verdictCorrect(verdict: AnswerVerdict): boolean {
  return verdict !== 'wrong' && verdict !== 'gave_up' && verdict !== 'skipped' && verdict !== 'seen';
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
    case 'cloze_typed':
      // Phase 27 (spec D5): the form the sentence needs; its lemma is wrong unless the sentence needs it.
      return judgeTyped({ answer: question.answer, lemma: question.answer, alternatives: question.alternatives }, text);
    case 'letter_tiles':
      return judgeTiles(question.answer, text);
  }
}

// answers_typed_text_length: a transcript is stored as the text of its answer.
const MAX_ANSWER_TEXT = 100;

// answers_typed_text_length (phase 27 D11)
export const MAX_JUDGED_TEXT = 300;

/**
 * Phase 34 (spec D9). The cards on which a right answer that is not the saved
 * word earns a second try: another accepted word (typed translation, say the
 * translation, typed cloze), another sense (typed meaning), or another word in a
 * sentence (sentence translation). A dictation accepts no alternative, and a
 * choice has no verdict.
 */
const RETRIED: ReadonlySet<QuestionType> = new Set([
  'typed_translation',
  'say_translation',
  'typed_meaning',
  'cloze_typed',
  'sentence_translation',
]);

type FirstAnswer = Omit<AnswerRecord, 'retry_state' | 'retry_answer_string' | 'retry_verdict'>;

/** Phase 34 (spec D9). A first answer, pending its retry when it opens one. */
function recorded(question: Question, first: FirstAnswer): AnswerRecord {
  const opens = first.verdict === 'alternative' && RETRIED.has(question.type);
  return { ...first, retry_state: opens ? 'pending' : null, retry_answer_string: null, retry_verdict: null };
}

// Callers check answerFits, and an option's range, first: the session's step
// owns those outcomes, so here a mismatch is a programming error. So is an
// unheard transcript, which step refuses before it gets here (spec D5).
export function evaluate(question: Question, answer: AnswerInput): AnswerRecord {
  if (isChoice(question) && 'option_index' in answer) {
    return recorded(question, {
      question_id: question.id,
      is_correct: answer.option_index === question.correct_option,
      answer_string: question.options[answer.option_index],
    });
  }
  if (isSpeaking(question) && 'heard' in answer) {
    const verdict = 'sounds_like' in answer ? 'understood' : spokenVerdict(question, answer.heard);
    if (verdict === 'unheard') throw new Error('an unheard transcript is never recorded (spec D5)');
    return recorded(question, { question_id: question.id, is_correct: true, answer_string: answer.heard.slice(0, MAX_ANSWER_TEXT), verdict });
  }
  if (isSpeaking(question) && 'pass' in answer) {
    const verdict = answer.pass === 'skip' ? 'skipped' : 'gave_up';
    return recorded(question, { question_id: question.id, is_correct: false, answer_string: '', verdict });
  }
  if (question.type === 'meet' && 'seen' in answer) {
    // Phase 54 (spec D6). Neither right nor wrong: score and missed leave it out.
    return recorded(question, { question_id: question.id, is_correct: false, answer_string: '', verdict: 'seen' });
  }
  if (isJudged(question) && 'judged' in answer) {
    return recorded(question, {
      question_id: question.id,
      is_correct: verdictCorrect(answer.judged),
      answer_string: answer.text.slice(0, MAX_JUDGED_TEXT),
      verdict: answer.judged,
    });
  }
  if (!isChoice(question) && !isJudged(question) && question.type !== 'read_aloud' && question.type !== 'meet' && 'text' in answer && !('judged' in answer)) {
    const verdict = verdictFor(question, answer.text);
    return recorded(question, { question_id: question.id, is_correct: verdictCorrect(verdict), answer_string: answer.text, verdict });
  }
  throw new Error(`the answer does not fit a ${question.type} question`);
}

/**
 * Phase 34 (spec D9). A second try, judged by the rule or the model call the
 * first answer was: the text and verdict it is stored with. An empty text, or
 * a pass, gives up; on a first answer an empty text is wrong. D9 ends a second
 * try with an answer or a give-up, so a skip there is a give-up too, never
 * `skipped` (the app sends show_answer, but the wire takes either). The caller
 * checks the answer's kind first, as for evaluate.
 */
export function evaluateRetry(question: Question, answer: AnswerInput): { answer_string: string; verdict: AnswerVerdict } {
  const { answer_string, verdict } = evaluate(question, answer);
  if (verdict === undefined) throw new Error(`a ${question.type} question has no second try`);
  const givenUp = ('text' in answer && answer.text.trim() === '') || 'pass' in answer;
  return { answer_string, verdict: givenUp ? 'gave_up' : verdict };
}

/**
 * Phase 34 (spec D9). The verdict progress reads: the retry's when it resolved
 * right (`exact`, `near_miss` or `understood`), which moves the word as that
 * verdict would; the first answer's otherwise. A retry given up, wrong or
 * another alternative leaves the answer where it was: right, and no progress.
 */
export function evidenceVerdict(verdict: AnswerVerdict, retryVerdict: AnswerVerdict | null): AnswerVerdict {
  return retryVerdict === 'exact' || retryVerdict === 'near_miss' || retryVerdict === 'understood' ? retryVerdict : verdict;
}

/** The answers a score and a missed list leave out: a skip is not a failure
 *  (phase 25, spec D9), and a meet card's `seen` asked nothing (phase 54, spec D6). */
const isUngraded = (record: AnswerRecord) => record.verdict === 'skipped' || record.verdict === 'seen';

/** Phase 25 (spec D9). A skipped card is not in the total: a skip is not a failure.
 *  Phase 34 (spec D9): the first answer counts, never its retry. Phase 54 (spec D6):
 *  a meet card is left out as a skip is. */
export function score(questions: readonly Question[], answers: readonly AnswerRecord[]): Score {
  return {
    correct: answers.filter((record) => record.is_correct).length,
    total: questions.length - answers.filter(isUngraded).length,
  };
}

export function missed(
  questions: readonly Question[],
  answers: readonly AnswerRecord[],
): MissedQuestion[] {
  return answers
    .filter((record) => !record.is_correct && !isUngraded(record))
    .flatMap((record) => {
      const question = questions.find((item) => item.id === record.question_id);
      return question ? [{ question, correct_answer: rightAnswer(question) }] : [];
    });
}

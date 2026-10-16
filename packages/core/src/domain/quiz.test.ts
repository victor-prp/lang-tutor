import { describe, expect, it } from '@jest/globals';

import type {
  ClozeTypedQuestion,
  DictationQuestion,
  LetterTilesQuestion,
  ListenChoiceQuestion,
  MatchingQuestion,
  MeetQuestion,
  MultipleChoiceQuestion,
  Question,
  ReadAloudQuestion,
  SayTranslationQuestion,
  TypedTranslationQuestion,
} from '../api/types';
import { seededRng } from '../utils/rng';
import {
  MAX_JUDGED_TEXT,
  SESSION_LENGTH,
  answerFits,
  evaluate,
  evaluateRetry,
  evidenceVerdict,
  isChoice,
  isJudged,
  missed,
  pickQuestions,
  rightAnswer,
  score,
  shuffleOptions,
  shuffleSession,
  spokenVerdict,
  takesHelp,
  verdictCorrect,
  type QuestionType,
} from './quiz';

function makeQuestion(n: number): MultipleChoiceQuestion {
  return {
    id: `q${n}`,
    type: 'multiple_choice',
    vocab_term_id: `v${n}`,
    question: `word ${n}`,
    options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
    correct_option: 0,
    context: null,
  };
}

const POOL: MultipleChoiceQuestion[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

// Phase 34 (spec D9). What every answer that opens no second try carries.
const NO_RETRY = { retry_state: null, retry_answer_string: null, retry_verdict: null };

// Phase 39 (spec D6). A new meaning is answered like a multiple choice.
describe('new_meaning', () => {
  const card: Question = {
    id: 'n1', type: 'new_meaning', vocab_term_id: 'v1', question: 'pick up', known_meanings: ['להרים'],
    options: ['לאסוף', 'לבשל', 'לשבור', 'לנגן'], correct_option: 0, context: null,
  };
  it('is a choice', () => {
    expect(isChoice(card)).toBe(true);
  });
  it('is graded by option_index like a multiple choice', () => {
    expect(evaluate(card, { option_index: 0 })).toMatchObject({ question_id: 'n1', is_correct: true, answer_string: 'לאסוף' });
    expect(evaluate(card, { option_index: 2 })).toMatchObject({ is_correct: false, answer_string: 'לשבור' });
  });
});

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
      if (question.type !== 'multiple_choice') throw new Error('the pool holds choices only');
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
    expect(evaluate(question, { option_index: question.correct_option })).toEqual({
      question_id: 'q1',
      is_correct: true,
      answer_string: 'a1',
      ...NO_RETRY,
    });
  });

  it('records answer_string for a wrong answer too', () => {
    const question = makeQuestion(2);
    expect(evaluate(question, { option_index: 3 })).toEqual({
      question_id: 'q2',
      is_correct: false,
      answer_string: 'd2',
      ...NO_RETRY,
    });
  });
});

describe('score', () => {
  it('counts correct answers against the number of questions asked', () => {
    const questions = [makeQuestion(1), makeQuestion(2), makeQuestion(3)];
    const answers = [
      evaluate(questions[0], { option_index: 0 }),
      evaluate(questions[1], { option_index: 1 }),
      evaluate(questions[2], { option_index: 0 }),
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
      evaluate(questions[0], { option_index: 0 }),
      evaluate(questions[1], { option_index: 2 }),
      evaluate(questions[2], { option_index: 0 }),
    ];
    expect(missed(questions, answers)).toEqual([
      { question: questions[1], correct_answer: 'a2' },
    ]);
  });

  it('returns an empty list for a perfect score', () => {
    const questions = [makeQuestion(1), makeQuestion(2)];
    const answers = questions.map((question) => evaluate(question, { option_index: question.correct_option }));
    expect(missed(questions, answers)).toEqual([]);
  });

  it('ignores answers whose question is not in the set', () => {
    const questions = [makeQuestion(1)];
    expect(missed(questions, [evaluate(makeQuestion(99), { option_index: 1 })])).toEqual([]);
  });
});

const typed: Question = {
  id: 't1',
  type: 'typed_translation',
  vocab_term_id: 'l1',
  question: 'בית',
  part_of_speech: 'noun',
  answer: 'casa',
  lemma: 'casa',
  alternatives: ['abitazione'],
  context: null,
};

describe('evaluate, typed', () => {
  it('keeps the text and the verdict, and counts every verdict but wrong', () => {
    expect(evaluate(typed, { text: 'casa' })).toEqual({
      question_id: 't1',
      is_correct: true,
      answer_string: 'casa',
      verdict: 'exact',
      ...NO_RETRY,
    });
    expect(evaluate(typed, { text: 'abitazione' })).toMatchObject({ is_correct: true, verdict: 'alternative' });
    expect(evaluate(typed, { text: '' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });

  it('lists a wrong typed answer as missed, with the saved form as the right answer', () => {
    expect(missed([typed], [evaluate(typed, { text: 'porta' })])).toEqual([
      { question: typed, correct_answer: 'casa' },
    ]);
  });

  it('refuses an answer of the wrong kind, either way round', () => {
    expect(answerFits(typed, { option_index: 0 })).toBe(false);
    expect(answerFits(typed, { text: 'casa' })).toBe(true);
    expect(answerFits(makeQuestion(1), { text: 'a1' })).toBe(false);
    expect(() => evaluate(typed, { option_index: 0 })).toThrow('does not fit');
  });
});

describe('rightAnswer and shuffleOptions', () => {
  it('reads the right answer of each type', () => {
    expect(rightAnswer(makeQuestion(3))).toBe('a3');
    expect(rightAnswer(typed)).toBe('casa');
  });

  it('leaves a typed card as it is: it has no options', () => {
    expect(shuffleOptions(typed, seededRng(1))).toBe(typed);
  });
});

const listen: ListenChoiceQuestion = {
  id: 'l1', type: 'listen_choice', vocab_term_id: 'v', question: 'casa',
  options: ['בית', 'דלת', 'קיר', 'גג'], correct_option: 0,
  part_of_speech: 'noun',
};
const dictation: DictationQuestion = { id: 'd1', type: 'dictation', vocab_term_id: 'v', question: 'parlo', meaning: 'מדבר' };
const tiles: LetterTilesQuestion = {
  id: 't1', type: 'letter_tiles', vocab_term_id: 'v', question: 'בית', part_of_speech: 'noun',
  answer: 'casa', tiles: ['s', 'a', 'c', 'x', 'a', 'q'],
};
const BOARD = { question_ids: ['m1', 'm2'], words: ['casa', 'gatto'], parts_of_speech: ['noun', 'noun'], correct_options: [0, 1] };
const word = (id: string, form: string, correct: number): MatchingQuestion => ({
  id, type: 'matching', vocab_term_id: 'v', question: form,
  options: ['בית', 'חתול', 'כלב'], correct_option: correct, board: BOARD,
  part_of_speech: 'noun',
});

describe('phase 24 types', () => {
  it('answers a listening card and a board word by option, the rest by text', () => {
    expect(answerFits(listen, { option_index: 0 })).toBe(true);
    expect(answerFits(word('m1', 'casa', 0), { option_index: 2 })).toBe(true);
    expect(answerFits(dictation, { text: 'parlo' })).toBe(true);
    expect(answerFits(tiles, { option_index: 0 })).toBe(false);
  });

  it('judges a dictation against the spoken form, and tiles exactly', () => {
    expect(evaluate(dictation, { text: 'parlare' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
    expect(evaluate(dictation, { text: 'parlo' })).toMatchObject({ is_correct: true, verdict: 'exact' });
    expect(evaluate(tiles, { text: 'casa' })).toMatchObject({ is_correct: true, verdict: 'exact' });
    expect(evaluate(listen, { option_index: 1 })).toEqual({ question_id: 'l1', is_correct: false, answer_string: 'דלת', ...NO_RETRY });
  });

  it('names the right answer: the meaning, the heard form, the built word', () => {
    expect(rightAnswer(listen)).toBe('בית');
    expect(rightAnswer(dictation)).toBe('parlo');
    expect(rightAnswer(tiles)).toBe('casa');
  });

  it('leaves a board word to shuffleSession: shuffleOptions alone would split the board', () => {
    const lone = word('m1', 'casa', 0);
    expect(shuffleOptions(lone, seededRng(5))).toBe(lone);
  });
});

describe('shuffleSession (phase 24, spec D10)', () => {
  it('shuffles a board once: every word shows one order, and the board follows it', () => {
    const shuffled = shuffleSession([listen, word('m1', 'casa', 0), word('m2', 'gatto', 1)], seededRng(5));
    const first = shuffled[1] as MatchingQuestion;
    const second = shuffled[2] as MatchingQuestion;
    expect(second.options).toEqual(first.options);
    expect(first.options[first.correct_option]).toBe('בית');
    expect(second.options[second.correct_option]).toBe('חתול');
    expect(first.board.correct_options).toEqual([first.correct_option, second.correct_option]);
    expect(second.board).toEqual(first.board);
  });

  it('shuffles every other choice on its own, as shuffleOptions does', () => {
    const [shown] = shuffleSession([listen], seededRng(5));
    expect(shown).toEqual(shuffleOptions(listen, seededRng(5)));
  });
});

const READ: ReadAloudQuestion = { id: 'r1', type: 'read_aloud', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' };
const SAY: SayTranslationQuestion = {
  id: 's1',
  type: 'say_translation',
  vocab_term_id: 'l2',
  question: 'מדבר',
  part_of_speech: 'verb',
  answer: 'parlo',
  lemma: 'parlare',
  alternatives: ['dico'],
  context: null,
};

describe('phase 25 speaking cards', () => {
  it('takes a transcript or a pass on a speaking card, and a text only on say the translation', () => {
    expect(answerFits(READ, { heard: 'gatto' })).toBe(true);
    expect(answerFits(READ, { pass: 'skip' })).toBe(true);
    expect(answerFits(READ, { pass: 'show_answer' })).toBe(false);
    expect(answerFits(READ, { text: 'gatto' })).toBe(false);
    expect(answerFits(READ, { option_index: 0 })).toBe(false);
    expect(answerFits(SAY, { heard: 'parlo' })).toBe(true);
    expect(answerFits(SAY, { pass: 'show_answer' })).toBe(true);
    expect(answerFits(SAY, { text: 'parlo' })).toBe(true);
    expect(answerFits(SAY, { option_index: 0 })).toBe(false);
  });

  it('a heard answer stores the transcript with its verdict, and counts as correct', () => {
    expect(evaluate(READ, { heard: 'il gatto' })).toEqual({
      question_id: 'r1',
      is_correct: true,
      answer_string: 'il gatto',
      verdict: 'understood',
      ...NO_RETRY,
    });
    expect(evaluate(SAY, { heard: 'parlare' })).toMatchObject({ is_correct: true, verdict: 'understood' });
    expect(evaluate(SAY, { heard: 'dico' })).toMatchObject({ is_correct: true, verdict: 'alternative' });
  });

  it('read aloud takes the form only, not its lemma', () => {
    const shown: ReadAloudQuestion = { ...READ, question: 'parlo' };
    expect(spokenVerdict(shown, 'parlare')).toBe('unheard');
    expect(spokenVerdict(SAY, 'parlare')).toBe('understood');
  });

  it('never records an unheard transcript', () => {
    expect(() => evaluate(READ, { heard: 'cane' })).toThrow(/unheard/);
  });

  // Phase 50 (spec D5). Only the server builds it, after a pronunciation score.
  it('records a transcript that sounds like the form as understood, storing what was heard', () => {
    expect(evaluate(READ, { heard: 'gato', sounds_like: 'gatto' })).toEqual({
      question_id: 'r1',
      is_correct: true,
      answer_string: 'gato',
      verdict: 'understood',
      ...NO_RETRY,
    });
    expect(evaluateRetry(SAY, { heard: 'barlo', sounds_like: 'parlo' })).toEqual({ answer_string: 'barlo', verdict: 'understood' });
  });

  it('stores at most 100 characters of a transcript', () => {
    const heard = `gatto ${'a'.repeat(200)}`;
    expect(evaluate(READ, { heard }).answer_string).toHaveLength(100);
  });

  it('a skip is neither right nor counted; show the answer is a failure', () => {
    expect(evaluate(READ, { pass: 'skip' })).toEqual({ question_id: 'r1', is_correct: false, answer_string: '', verdict: 'skipped', ...NO_RETRY });
    expect(evaluate(SAY, { pass: 'show_answer' })).toEqual({ question_id: 's1', is_correct: false, answer_string: '', verdict: 'gave_up', ...NO_RETRY });
  });

  it('a typed answer to say the translation is judged as a typed card', () => {
    expect(evaluate(SAY, { text: 'parlare' })).toMatchObject({ is_correct: true, verdict: 'exact' });
    expect(evaluate(SAY, { text: 'mangio' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });

  it('the right answer of a read-aloud card is its form, of say the translation its word', () => {
    expect(rightAnswer(READ)).toBe('gatto');
    expect(rightAnswer(SAY)).toBe('parlo');
  });

  it('leaves a skipped card out of the score and of the missed list (spec D9)', () => {
    const answers = [evaluate(READ, { pass: 'skip' }), evaluate(SAY, { pass: 'show_answer' })];
    expect(score([READ, SAY], answers)).toEqual({ correct: 0, total: 1 });
    expect(missed([READ, SAY], answers).map((item) => item.question.id)).toEqual(['s1']);
  });

  it('knows which stored verdicts are right', () => {
    expect(['exact', 'near_miss', 'alternative', 'understood'].every((v) => verdictCorrect(v as never))).toBe(true);
    expect(['wrong', 'gave_up', 'skipped'].some((v) => verdictCorrect(v as never))).toBe(false);
  });
});

const MEANING: Question = {
  id: 'm1',
  type: 'typed_meaning',
  vocab_term_id: 'l1',
  question: 'parlare',
  part_of_speech: 'verb',
  meaning: 'לדבר',
  context: null,
};

describe('typed_meaning (phase 27 D3)', () => {
  it('is judged, not a choice and not speaking', () => {
    expect(isJudged(MEANING)).toBe(true);
    expect(isChoice(MEANING)).toBe(false);
    expect(isJudged({ ...MEANING, type: 'typed_translation', answer: 'x', lemma: 'x', alternatives: [], context: null } as Question)).toBe(false);
  });
  it('takes only a judged text', () => {
    expect(answerFits(MEANING, { text: 'לדבר', judged: 'exact' })).toBe(true);
    expect(answerFits(MEANING, { text: 'לדבר' })).toBe(false);
    expect(answerFits(MEANING, { option_index: 0 })).toBe(false);
  });
  it('records the verdict it was given, never judging itself', () => {
    expect(evaluate(MEANING, { text: 'לשוחח', judged: 'exact' })).toEqual({
      question_id: 'm1',
      is_correct: true,
      answer_string: 'לשוחח',
      verdict: 'exact',
      ...NO_RETRY,
    });
    expect(evaluate(MEANING, { text: 'ספר', judged: 'alternative' })).toMatchObject({ is_correct: true, verdict: 'alternative' });
    expect(evaluate(MEANING, { text: 'לאכול', judged: 'wrong' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });
  it('stores at most MAX_JUDGED_TEXT characters', () => {
    const long = 'א'.repeat(MAX_JUDGED_TEXT + 20);
    expect(evaluate(MEANING, { text: long, judged: 'wrong' }).answer_string).toHaveLength(MAX_JUDGED_TEXT);
  });
  it('a typed card still refuses a judged answer', () => {
    const typed: Question = { id: 't1', type: 'typed_translation', vocab_term_id: 'l1', question: 'לדבר', part_of_speech: 'verb', answer: 'parlare', lemma: 'parlare', alternatives: [], context: null };
    expect(answerFits(typed, { text: 'parlare', judged: 'exact' })).toBe(false);
  });
  it('its right answer is the meaning, and it is missed like any card', () => {
    expect(rightAnswer(MEANING)).toBe('לדבר');
    const record = evaluate(MEANING, { text: '', judged: 'wrong' });
    expect(missed([MEANING], [record])).toEqual([{ question: MEANING, correct_answer: 'לדבר' }]);
  });
});

const CLOZE_CHOICE: Question = {
  id: 'cc',
  type: 'cloze_choice',
  vocab_term_id: 'l1',
  sentence: 'Vorrei prenotare un tavolo.',
  gap: { start: 7, end: 16 },
  translation: 'הייתי רוצה להזמין שולחן.',
  meaning: 'להזמין',
  options: ['prenotare', 'mangiare', 'dormire', 'correre'],
  correct_option: 0,
};
const CLOZE_TYPED: Question = {
  id: 'ct',
  type: 'cloze_typed',
  vocab_term_id: 'l2',
  sentence: 'Ieri parlavamo per ore.',
  gap: { start: 5, end: 14 },
  translation: 'אתמול דיברנו שעות.',
  meaning: 'לדבר',
  answer: 'parlavamo',
  alternatives: ['chiacchieravamo'],
  mark: null,
};
const TRANSLATION: Question = {
  id: 'st',
  type: 'sentence_translation',
  vocab_term_id: 'l3',
  question: 'אני רוצה להזמין שולחן',
  meaning: 'להזמין',
  sentence: 'Voglio prenotare un tavolo.',
  gap: { start: 7, end: 16 },
  answer: 'prenotare',
  mark: null,
};

describe('phase 27 Part B cards', () => {
  it('a gap choice is a choice, judged by its option', () => {
    expect(isChoice(CLOZE_CHOICE)).toBe(true);
    expect(evaluate(CLOZE_CHOICE, { option_index: 0 })).toMatchObject({ is_correct: true, answer_string: 'prenotare' });
    expect(rightAnswer(CLOZE_CHOICE)).toBe('prenotare');
  });
  it('a typed gap wants the form the sentence needs', () => {
    expect(evaluate(CLOZE_TYPED, { text: 'parlavamo' })).toMatchObject({ verdict: 'exact', is_correct: true });
    expect(evaluate(CLOZE_TYPED, { text: 'parlare' })).toMatchObject({ verdict: 'wrong', is_correct: false });
    expect(evaluate(CLOZE_TYPED, { text: 'parlavano' })).toMatchObject({ verdict: 'near_miss' });
    expect(evaluate(CLOZE_TYPED, { text: 'chiacchieravamo' })).toMatchObject({ verdict: 'alternative' });
    expect(rightAnswer(CLOZE_TYPED)).toBe('parlavamo');
    expect(answerFits(CLOZE_TYPED, { text: 'x', judged: 'exact' })).toBe(false);
  });
  it('a translation is judged by the server', () => {
    expect(isJudged(TRANSLATION)).toBe(true);
    expect(answerFits(TRANSLATION, { text: 'x' })).toBe(false);
    expect(evaluate(TRANSLATION, { text: 'Vorrei prenotare un tavolo', judged: 'exact' })).toMatchObject({
      is_correct: true,
      verdict: 'exact',
    });
    expect(rightAnswer(TRANSLATION)).toBe('Voglio prenotare un tavolo.');
  });
  it('no card that is not judged takes a judged answer', () => {
    const say: Question = {
      id: 's',
      type: 'say_translation',
      vocab_term_id: 'l',
      question: 'לדבר',
      part_of_speech: 'verb',
      answer: 'parlare',
      lemma: 'parlare',
      alternatives: [],
      context: null,
    };
    expect(answerFits(say, { text: 'parlare', judged: 'exact' })).toBe(false);
  });
});

// Phase 34 (spec D9). A right answer that is not the saved word earns one more try.
describe('the second try (phase 34, spec D9)', () => {
  it('marks an alternative pending on the five cards that offer a second try', () => {
    expect(evaluate(typed, { text: 'abitazione' })).toEqual({
      question_id: 't1',
      is_correct: true,
      answer_string: 'abitazione',
      verdict: 'alternative',
      retry_state: 'pending',
      retry_answer_string: null,
      retry_verdict: null,
    });
    expect(evaluate(SAY, { heard: 'dico' })).toMatchObject({ verdict: 'alternative', retry_state: 'pending' });
    expect(evaluate(SAY, { text: 'dico' })).toMatchObject({ verdict: 'alternative', retry_state: 'pending' });
    expect(evaluate(MEANING, { text: 'לשוחח', judged: 'alternative' })).toMatchObject({ retry_state: 'pending' });
    expect(evaluate(CLOZE_TYPED, { text: 'chiacchieravamo' })).toMatchObject({ retry_state: 'pending' });
    expect(evaluate(TRANSLATION, { text: 'Voglio riservare un tavolo', judged: 'alternative' })).toMatchObject({ retry_state: 'pending' });
  });

  it('opens none on any other verdict, and none on a choice or a dictation', () => {
    expect(evaluate(typed, { text: 'casa' })).toMatchObject({ retry_state: null, retry_answer_string: null, retry_verdict: null });
    expect(evaluate(typed, { text: 'porta' })).toMatchObject({ retry_state: null });
    expect(evaluate(SAY, { pass: 'show_answer' })).toMatchObject({ retry_state: null });
    expect(evaluate(makeQuestion(1), { option_index: 0 })).toEqual({
      question_id: 'q1',
      is_correct: true,
      answer_string: 'a1',
      retry_state: null,
      retry_answer_string: null,
      retry_verdict: null,
    });
    expect(evaluate(dictation, { text: 'parlo' })).toMatchObject({ verdict: 'exact', retry_state: null });
  });

  it('judges a retry as the first answer was, and takes an empty text, show the answer or a skip as giving up', () => {
    expect(evaluateRetry(typed, { text: 'casa' })).toEqual({ answer_string: 'casa', verdict: 'exact' });
    expect(evaluateRetry(typed, { text: 'porta' })).toEqual({ answer_string: 'porta', verdict: 'wrong' });
    expect(evaluateRetry(typed, { text: '  ' })).toEqual({ answer_string: '  ', verdict: 'gave_up' });
    expect(evaluateRetry(SAY, { heard: 'parlo' })).toEqual({ answer_string: 'parlo', verdict: 'understood' });
    expect(evaluateRetry(SAY, { pass: 'show_answer' })).toEqual({ answer_string: '', verdict: 'gave_up' });
    // D9 ends a second try with an answer or a give-up: a skip is never stored as skipped.
    expect(evaluateRetry(SAY, { pass: 'skip' })).toEqual({ answer_string: '', verdict: 'gave_up' });
    expect(evaluateRetry(MEANING, { text: 'לדבר', judged: 'exact' })).toEqual({ answer_string: 'לדבר', verdict: 'exact' });
    // The judged route's rule calls an empty text wrong; as a retry it is a give-up.
    expect(evaluateRetry(MEANING, { text: '', judged: 'wrong' })).toEqual({ answer_string: '', verdict: 'gave_up' });
  });

  it('scores the first answer, whatever its retry came to', () => {
    const first = evaluate(typed, { text: 'abitazione' });
    const resolved = { ...first, retry_state: 'resolved' as const, retry_answer_string: 'porta', retry_verdict: 'wrong' as const };
    expect(score([typed], [resolved])).toEqual({ correct: 1, total: 1 });
    expect(missed([typed], [resolved])).toEqual([]);
  });

  it("counts the retry for progress when it resolved right, and the first answer otherwise", () => {
    expect(evidenceVerdict('alternative', 'exact')).toBe('exact');
    expect(evidenceVerdict('alternative', 'near_miss')).toBe('near_miss');
    expect(evidenceVerdict('alternative', 'understood')).toBe('understood');
    for (const retry of ['wrong', 'gave_up', 'alternative', 'skipped'] as const) {
      expect(evidenceVerdict('alternative', retry)).toBe('alternative');
    }
    expect(evidenceVerdict('exact', null)).toBe('exact');
  });
});

// Phase 54 (spec D1, D6). A new word shown before it is asked: ungraded, answered with `seen`.
const MEET: MeetQuestion = { id: 'e1', type: 'meet', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' };

describe('the meet card and the seen answer (phase 54, spec D6)', () => {
  it('takes `seen` and nothing else, and no other card takes it', () => {
    expect(answerFits(MEET, { seen: true })).toBe(true);
    expect(answerFits(MEET, { option_index: 0 })).toBe(false);
    expect(answerFits(MEET, { text: 'x' })).toBe(false);
    expect(answerFits(MEET, { pass: 'skip' })).toBe(false);
    expect(answerFits(MEET, { heard: 'gatto' })).toBe(false);
    for (const card of [READ, SAY, MEANING, typed, makeQuestion(1)]) {
      expect(answerFits(card, { seen: true })).toBe(false);
    }
  });

  it('records `seen` as a wrong-looking, empty answer with no retry', () => {
    expect(evaluate(MEET, { seen: true })).toEqual({
      question_id: 'e1',
      is_correct: false,
      answer_string: '',
      verdict: 'seen',
      ...NO_RETRY,
    });
  });

  it('is not a choice, and its right answer is its form', () => {
    expect(isChoice(MEET)).toBe(false);
    expect(rightAnswer(MEET)).toBe('gatto');
  });

  it('a seen verdict is not right', () => {
    expect(verdictCorrect('seen')).toBe(false);
  });

  it('leaves a meet card out of the score total and of the missed list, as a skip', () => {
    const mc = makeQuestion(1);
    const answers = [evaluate(MEET, { seen: true }), evaluate(mc, { option_index: 0 })];
    expect(score([MEET, mc], answers)).toEqual({ correct: 1, total: 1 });
    expect(missed([MEET, mc], answers)).toEqual([]);
    const wrong = [evaluate(MEET, { seen: true }), evaluate(mc, { option_index: 1 })];
    expect(score([MEET, mc], wrong)).toEqual({ correct: 0, total: 1 });
    expect(missed([MEET, mc], wrong).map((item) => item.question.id)).toEqual([mc.id]);
  });

  it('is shuffled as a text card is: not at all', () => {
    expect(shuffleOptions(MEET, seededRng(1))).toBe(MEET);
  });
});

// Phase 54 (final review). A ladder asks one word three ways in a session; the missed
// list names a word once, by its first wrong card. `vocab_term_id` is the card's lexeme,
// and a session asks one gloss of a family at most (phase 39 D5), one lexeme's glosses
// being one family, so within a session it names the gloss.
describe('missed, a ladder (phase 54)', () => {
  const choice: MultipleChoiceQuestion = { ...makeQuestion(1), id: 'c1', vocab_term_id: 'l1', question: 'gatto' };
  const reverse: Question = {
    id: 'r1', type: 'reverse_choice', vocab_term_id: 'l1', question: 'חתול', part_of_speech: 'noun',
    options: ['gatto', 'cane', 'casa', 'porta'], correct_option: 0, context: null,
  };
  const ladder: Question[] = [MEET, choice, reverse, typed];

  it('lists a ladder whose three practice cards were all wrong once, by its first wrong card', () => {
    const answers = [
      evaluate(MEET, { seen: true }),
      evaluate(choice, { option_index: 1 }),
      evaluate(reverse, { option_index: 2 }),
      evaluate(typed, { text: 'porta' }),
    ];
    expect(missed(ladder, answers)).toEqual([{ question: choice, correct_answer: 'a1' }]);
  });

  it('lists the first wrong card when the earlier ones were right', () => {
    const answers = [
      evaluate(MEET, { seen: true }),
      evaluate(choice, { option_index: 0 }),
      evaluate(reverse, { option_index: 2 }),
      evaluate(typed, { text: 'porta' }),
    ];
    expect(missed(ladder, answers).map((item) => item.question.id)).toEqual(['r1']);
  });

  it('still lists two different words wrong as two rows', () => {
    const other = makeQuestion(2);
    const answers = [
      evaluate(MEET, { seen: true }),
      evaluate(choice, { option_index: 1 }),
      evaluate(other, { option_index: 1 }),
      evaluate(reverse, { option_index: 2 }),
      evaluate(typed, { text: 'porta' }),
    ];
    expect(missed([...ladder, other], answers).map((item) => item.question.id)).toEqual(['c1', 'q2']);
  });
});

describe('phase 55: helped', () => {
  it('records a helped tiles or typed answer wrong, whatever its text', () => {
    expect(evaluate(tiles, { text: tiles.answer, helped: true })).toMatchObject({ is_correct: false, verdict: 'wrong', answer_string: tiles.answer });
    expect(evaluate(typed, { text: (typed as TypedTranslationQuestion).answer, helped: true })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });
  it('grades an unhelped answer as today', () => {
    expect(evaluate(tiles, { text: tiles.answer, helped: false }).verdict).toBe('exact');
    expect(evaluate(typed, { text: (typed as TypedTranslationQuestion).answer }).verdict).toBe('exact');
  });
  it('ignores helped on any other type', () => {
    expect(evaluate(dictation, { text: 'parlo', helped: true }).verdict).toBe('exact');
    expect(evaluate(CLOZE_TYPED, { text: (CLOZE_TYPED as ClozeTypedQuestion).answer, helped: true }).verdict).toBe('exact');
  });
  it('records a helped second try wrong', () => {
    expect(evaluateRetry(typed, { text: (typed as TypedTranslationQuestion).answer, helped: true }).verdict).toBe('wrong');
  });
  // Review M8. The one list of the cards that take help, which the server stores `helped` by:
  // every type named, so a new one must say whether it takes help.
  it('takes help on tiles and typed translation cards and nowhere else', () => {
    const TAKES_HELP: Record<QuestionType, boolean> = {
      multiple_choice: false,
      new_meaning: false,
      reverse_choice: false,
      typed_translation: true,
      listen_choice: false,
      dictation: false,
      matching: false,
      letter_tiles: true,
      read_aloud: false,
      meet: false,
      say_translation: false,
      typed_meaning: false,
      cloze_choice: false,
      cloze_typed: false,
      sentence_translation: false,
    };
    for (const [type, takes] of Object.entries(TAKES_HELP)) expect([type, takesHelp(type as QuestionType)]).toEqual([type, takes]);
  });
});

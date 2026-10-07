import { describe, expect, it } from '@jest/globals';

import type {
  DictationQuestion,
  LetterTilesQuestion,
  ListenChoiceQuestion,
  MatchingQuestion,
  MultipleChoiceQuestion,
  Question,
  ReadAloudQuestion,
  SayTranslationQuestion,
} from '../api/types';
import { seededRng } from '../utils/rng';
import {
  MAX_JUDGED_TEXT,
  SESSION_LENGTH,
  answerFits,
  evaluate,
  isChoice,
  isJudged,
  missed,
  pickQuestions,
  rightAnswer,
  score,
  shuffleOptions,
  shuffleSession,
  spokenVerdict,
  verdictCorrect,
} from './quiz';

function makeQuestion(n: number): MultipleChoiceQuestion {
  return {
    id: `q${n}`,
    type: 'multiple_choice',
    vocab_term_id: `v${n}`,
    question: `word ${n}`,
    options: [`a${n}`, `b${n}`, `c${n}`, `d${n}`],
    correct_option: 0,
  };
}

const POOL: MultipleChoiceQuestion[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

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
    });
  });

  it('records answer_string for a wrong answer too', () => {
    const question = makeQuestion(2);
    expect(evaluate(question, { option_index: 3 })).toEqual({
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
};

describe('evaluate, typed', () => {
  it('keeps the text and the verdict, and counts every verdict but wrong', () => {
    expect(evaluate(typed, { text: 'casa' })).toEqual({
      question_id: 't1',
      is_correct: true,
      answer_string: 'casa',
      verdict: 'exact',
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
};
const dictation: DictationQuestion = { id: 'd1', type: 'dictation', vocab_term_id: 'v', question: 'parlo', meaning: 'מדבר' };
const tiles: LetterTilesQuestion = {
  id: 't1', type: 'letter_tiles', vocab_term_id: 'v', question: 'בית', part_of_speech: 'noun',
  answer: 'casa', tiles: ['s', 'a', 'c', 'x', 'a', 'q'],
};
const BOARD = { question_ids: ['m1', 'm2'], words: ['casa', 'gatto'], correct_options: [0, 1] };
const word = (id: string, form: string, correct: number): MatchingQuestion => ({
  id, type: 'matching', vocab_term_id: 'v', question: form,
  options: ['בית', 'חתול', 'כלב'], correct_option: correct, board: BOARD,
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
    expect(evaluate(listen, { option_index: 1 })).toEqual({ question_id: 'l1', is_correct: false, answer_string: 'דלת' });
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

  it('stores at most 100 characters of a transcript', () => {
    const heard = `gatto ${'a'.repeat(200)}`;
    expect(evaluate(READ, { heard }).answer_string).toHaveLength(100);
  });

  it('a skip is neither right nor counted; show the answer is a failure', () => {
    expect(evaluate(READ, { pass: 'skip' })).toEqual({ question_id: 'r1', is_correct: false, answer_string: '', verdict: 'skipped' });
    expect(evaluate(SAY, { pass: 'show_answer' })).toEqual({ question_id: 's1', is_correct: false, answer_string: '', verdict: 'gave_up' });
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
};

describe('typed_meaning (phase 27 D3)', () => {
  it('is judged, not a choice and not speaking', () => {
    expect(isJudged(MEANING)).toBe(true);
    expect(isChoice(MEANING)).toBe(false);
    expect(isJudged({ ...MEANING, type: 'typed_translation', answer: 'x', lemma: 'x', alternatives: [] } as Question)).toBe(false);
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
    });
    expect(evaluate(MEANING, { text: 'ספר', judged: 'alternative' })).toMatchObject({ is_correct: true, verdict: 'alternative' });
    expect(evaluate(MEANING, { text: 'לאכול', judged: 'wrong' })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });
  it('stores at most MAX_JUDGED_TEXT characters', () => {
    const long = 'א'.repeat(MAX_JUDGED_TEXT + 20);
    expect(evaluate(MEANING, { text: long, judged: 'wrong' }).answer_string).toHaveLength(MAX_JUDGED_TEXT);
  });
  it('a typed card still refuses a judged answer', () => {
    const typed: Question = { id: 't1', type: 'typed_translation', vocab_term_id: 'l1', question: 'לדבר', part_of_speech: 'verb', answer: 'parlare', lemma: 'parlare', alternatives: [] };
    expect(answerFits(typed, { text: 'parlare', judged: 'exact' })).toBe(false);
  });
  it('its right answer is the meaning, and it is missed like any card', () => {
    expect(rightAnswer(MEANING)).toBe('לדבר');
    const record = evaluate(MEANING, { text: '', judged: 'wrong' });
    expect(missed([MEANING], [record])).toEqual([{ question: MEANING, correct_answer: 'לדבר' }]);
  });
});

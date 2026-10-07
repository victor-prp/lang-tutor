import { describe, expect, it } from '@jest/globals';
import type { AnswerRecord, MultipleChoiceQuestion, Question, SessionStatus, TypedTranslationQuestion } from '@lang-tutor/core/api';
import { SESSION_LENGTH } from '@lang-tutor/core/domain';

import {
  currentQuestion,
  isCurrent,
  isOpen,
  missedQuestions,
  newSessionRecord,
  nextSource,
  pickSenses,
  positionOf,
  sessionScore,
  step,
  type SessionRecord,
} from './session';

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

// Not tests/support/testRng: ADR 0001 R3 greps domain/ for any parent-directory
// import, test files included, so a domain test cannot reach tests/support.
// Same LCG.
function testRng(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

const POOL: Question[] = Array.from({ length: 16 }, (_, i) => makeQuestion(i));

function makeRecord(questions: Question[], answers: AnswerRecord[] = []): SessionRecord {
  return {
    user_id: 'u1',
    questions,
    answers,
    complete: answers.length === questions.length,
    completed_at: null,
    status: answers.length === questions.length ? 'completed' : 'ready',
    source: 'seed',
  };
}

describe('newSessionRecord', () => {
  it('starts with no answers and the first question current', () => {
    const record = newSessionRecord('u1', POOL, () => 0.5);
    expect(record.questions).toHaveLength(SESSION_LENGTH);
    expect(record.answers).toEqual([]);
    expect(record.complete).toBe(false);
    expect(record.completed_at).toBeNull();
    expect(record.user_id).toBe('u1');
    expect(currentQuestion(record)).toBe(record.questions[0]);
    expect(positionOf(record)).toEqual({ position: 1, total: SESSION_LENGTH });
  });
});

describe('positionOf', () => {
  it('reports 1-based position, capped at total once complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    expect(positionOf(done)).toEqual({ position: 1, total: 1 });
  });
});

describe('step', () => {
  it('records a fresh answer and advances to the next question', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const outcome = step(makeRecord([q0, q1]), q0.id, { option_index: q0.correct_option });
    expect(outcome.status).toBe('advanced');
    if (outcome.status !== 'advanced') throw new Error('unreachable');
    expect(outcome.record.answers).toHaveLength(1);
    expect(outcome.record.answers[0]).toEqual({
      question_id: q0.id,
      is_correct: true,
      answer_string: q0.options[q0.correct_option],
    });
    expect(outcome.record.complete).toBe(false);
    expect(outcome.justCompleted).toBe(false);
    expect(currentQuestion(outcome.record)).toBe(q1);
  });

  it('marks the record complete on the last question and reports justCompleted', () => {
    const q0 = makeQuestion(0);
    const outcome = step(makeRecord([q0]), q0.id, { option_index: q0.correct_option });
    expect(outcome.status).toBe('advanced');
    if (outcome.status !== 'advanced') throw new Error('unreachable');
    expect(outcome.record.complete).toBe(true);
    expect(outcome.justCompleted).toBe(true);
    expect(currentQuestion(outcome.record)).toBeUndefined();
  });

  it('replays the same outcome when retried with the question that was just answered', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const answered = makeRecord(
      [q0, q1],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    const outcome = step(answered, q0.id, { option_index: q0.correct_option });
    expect(outcome).toEqual({ status: 'replayed', record: answered, justCompleted: false });
  });

  it('replays the completion outcome when retried after the session is already complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    expect(done.complete).toBe(true);
    const outcome = step(done, q0.id, { option_index: q0.correct_option });
    expect(outcome).toEqual({ status: 'replayed', record: done, justCompleted: false });
  });

  it('rejects a question_id that matches neither the current nor the just-answered question', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const outcome = step(makeRecord([q0, q1]), 'not-a-real-id', { option_index: 0 });
    expect(outcome).toEqual({ status: 'invalid_question' });
  });

  it('rejects a stale question_id once the session is complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    const outcome = step(done, 'not-a-real-id', { option_index: 0 });
    expect(outcome).toEqual({ status: 'invalid_question' });
  });

  it('rejects an option index past the last option, without evaluating it', () => {
    const q0 = makeQuestion(0);
    expect(step(makeRecord([q0]), q0.id, { option_index: q0.options.length })).toEqual({ status: 'out_of_range' });
  });

  it('rejects a negative option index', () => {
    const q0 = makeQuestion(0);
    expect(step(makeRecord([q0]), q0.id, { option_index: -1 })).toEqual({ status: 'out_of_range' });
  });

  // The range check must not fire on a replay: the record comes back unchanged,
  // so there is no answer to evaluate and nothing to be out of range for.
  it('replays a just-answered question regardless of the option index', () => {
    const [q0, q1] = [makeQuestion(0), makeQuestion(1)];
    const answered = makeRecord(
      [q0, q1],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option] }],
    );
    expect(step(answered, q0.id, { option_index: 99 })).toEqual({
      status: 'replayed',
      record: answered,
      justCompleted: false,
    });
  });
});

// Phase 23.
function typedQuestion(id: string): TypedTranslationQuestion {
  return {
    id,
    type: 'typed_translation',
    vocab_term_id: 'l1',
    question: 'חלון',
    part_of_speech: 'noun',
    answer: 'finestra',
    lemma: 'finestra',
    alternatives: [],
  };
}

describe('step, typed', () => {
  const [t1, t2] = [typedQuestion('t1'), typedQuestion('t2')];

  it('records a typed answer with its text and verdict', () => {
    const outcome = step(makeRecord([t1, t2]), 't1', { text: 'finestar' });
    if (outcome.status !== 'advanced') throw new Error(outcome.status);
    expect(outcome.record.answers[0]).toEqual({
      question_id: 't1',
      is_correct: true,
      answer_string: 'finestar',
      verdict: 'near_miss',
    });
  });

  it('refuses text for a choice and an index for a typed card', () => {
    const q0 = makeQuestion(0);
    expect(step(makeRecord([q0]), q0.id, { text: 'a0' })).toEqual({ status: 'wrong_answer_kind' });
    expect(step(makeRecord([t1]), 't1', { option_index: 0 })).toEqual({ status: 'wrong_answer_kind' });
  });

  // Review Focus 3: the client resends after the server recorded the answer.
  it('replays a retried typed answer without recording it twice', () => {
    const first = step(makeRecord([t1, t2]), 't1', { text: 'finestra' });
    if (first.status !== 'advanced') throw new Error(first.status);
    const retried = step(first.record, 't1', { text: 'finestra' });
    expect(retried).toEqual({ status: 'replayed', record: first.record, justCompleted: false });
  });
});

describe('sessionScore and missedQuestions', () => {
  it('delegates to the shared domain rules', () => {
    const [q0, q1, q2] = [makeQuestion(0), makeQuestion(1), makeQuestion(2)];
    const record = makeRecord(
      [q0, q1, q2],
      [
        { question_id: q0.id, is_correct: true, answer_string: q0.options[0] },
        { question_id: q1.id, is_correct: false, answer_string: q1.options[1] },
        { question_id: q2.id, is_correct: true, answer_string: q2.options[0] },
      ],
    );
    expect(sessionScore(record)).toEqual({ correct: 2, total: 3 });
    expect(missedQuestions(record)).toEqual([
      { question: q1, correct_answer: q1.options[q1.correct_option] },
    ]);
  });
});

describe('pickSenses', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ senseId: `s${i}` }));

  it('takes at most `max`, with no repeats', () => {
    const picked = pickSenses(entries, 10, testRng(3));
    expect(picked).toHaveLength(10);
    expect(new Set(picked.map((e) => e.senseId)).size).toBe(10);
  });

  it('takes all of a shorter list', () => {
    expect(pickSenses(entries.slice(0, 4), 10, testRng(3))).toHaveLength(4);
  });

  it('is a pure function of the rng, and leaves its input alone', () => {
    const copy = [...entries];
    expect(pickSenses(entries, 10, testRng(5))).toEqual(pickSenses(entries, 10, testRng(5)));
    expect(entries).toEqual(copy);
  });
});

describe('nextSource and status sets', () => {
  const ALL: SessionStatus[] = ['preparing', 'ready', 'completed', 'skipped', 'failed'];

  it('starts with the seed and moves to the list once any session exists', () => {
    expect(nextSource(false)).toBe('seed');
    expect(nextSource(true)).toBe('list');
  });

  it('counts preparing and ready as open; failed is current but not open', () => {
    expect(ALL.filter(isOpen)).toEqual(['preparing', 'ready']);
    expect(ALL.filter(isCurrent)).toEqual(['preparing', 'ready', 'failed']);
  });
});

describe('step and status', () => {
  it('marks the record completed on its last answer', () => {
    let record = newSessionRecord('u1', POOL, () => 0.5);
    expect(record.status).toBe('ready');
    expect(record.source).toBe('seed');
    for (const question of [...record.questions]) {
      const outcome = step(record, question.id, { option_index: 0 });
      if (outcome.status !== 'advanced') throw new Error(outcome.status);
      record = outcome.record;
    }
    expect(record.complete).toBe(true);
    expect(record.status).toBe('completed');
  });
});

describe('phase 25 speaking cards in step', () => {
  const record = (): SessionRecord => ({
    user_id: 'u1',
    questions: [
      { id: 'r1', type: 'read_aloud', vocab_term_id: 'l1', question: 'gatto', meaning: 'חתול' },
      { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0 },
    ],
    answers: [],
    complete: false,
    completed_at: null,
    status: 'ready',
    source: 'list',
  });

  it('records an understood transcript and advances', () => {
    const outcome = step(record(), 'r1', { heard: 'gatto' });
    expect(outcome).toMatchObject({ status: 'advanced' });
    if (outcome.status === 'advanced') expect(outcome.record.answers[0]).toMatchObject({ verdict: 'understood' });
  });

  it('refuses an unheard transcript and changes nothing (spec D5)', () => {
    expect(step(record(), 'r1', { heard: 'cane' })).toEqual({ status: 'unheard' });
  });

  it('passes a read-aloud card with skip, and refuses show_answer there', () => {
    expect(step(record(), 'r1', { pass: 'skip' })).toMatchObject({ status: 'advanced' });
    expect(step(record(), 'r1', { pass: 'show_answer' })).toEqual({ status: 'wrong_answer_kind' });
  });

  it('replays a transcript sent again for the card just answered', () => {
    const outcome = step(record(), 'r1', { heard: 'gatto' });
    if (outcome.status !== 'advanced') throw new Error('expected advanced');
    expect(step(outcome.record, 'r1', { heard: 'gatto' })).toMatchObject({ status: 'replayed' });
  });
});

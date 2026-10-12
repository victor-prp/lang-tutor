import { describe, expect, it } from '@jest/globals';
import type { AnswerRecord, MultipleChoiceQuestion, Question, SessionStatus, TypedTranslationQuestion } from '@lang-tutor/core/api';
import { SESSION_LENGTH, type AnswerInput } from '@lang-tutor/core/domain';

import {
  askableRenderings,
  currentQuestion,
  isCurrent,
  isOpen,
  missedQuestions,
  newSessionRecord,
  nextSource,
  pickRendering,
  pendingRetryOf,
  shuffle,
  positionOf,
  sessionScore,
  step as stepRaw,
  type GlossRendering,
  type SavedGloss,
  type SessionRecord,
} from './session';

// Phase 39 (spec D10). `step` takes the enrollment's languages: Italian learned by a Hebrew speaker.
const LANGUAGES = { target: 'it', learner: 'he' } as const;
const step = (record: SessionRecord, questionId: string, answer: AnswerInput, options: { retry?: boolean } = {}) =>
  stepRaw(record, questionId, answer, { languages: LANGUAGES, ...options });

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

// Phase 34 (spec D9). What every answer that opens no second try carries.
const NO_RETRY = { retry_state: null, retry_answer_string: null, retry_verdict: null };

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
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option], ...NO_RETRY }],
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
      ...NO_RETRY,
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
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option], ...NO_RETRY }],
    );
    const outcome = step(answered, q0.id, { option_index: q0.correct_option });
    expect(outcome).toEqual({ status: 'replayed', record: answered, justCompleted: false });
  });

  it('replays the completion outcome when retried after the session is already complete', () => {
    const q0 = makeQuestion(0);
    const done = makeRecord(
      [q0],
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option], ...NO_RETRY }],
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
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option], ...NO_RETRY }],
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
      [{ question_id: q0.id, is_correct: true, answer_string: q0.options[q0.correct_option], ...NO_RETRY }],
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
    context: null,
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
      ...NO_RETRY,
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
        { question_id: q0.id, is_correct: true, answer_string: q0.options[0], ...NO_RETRY },
        { question_id: q1.id, is_correct: false, answer_string: q1.options[1], ...NO_RETRY },
        { question_id: q2.id, is_correct: true, answer_string: q2.options[0], ...NO_RETRY },
      ],
    );
    expect(sessionScore(record)).toEqual({ correct: 2, total: 3 });
    expect(missedQuestions(record)).toEqual([
      { question: q1, correct_answer: q1.options[q1.correct_option] },
    ]);
  });
});

describe('shuffle', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ glossId: `s${i}` }));

  it('keeps every entry once', () => {
    const shuffled = shuffle(entries, testRng(3));
    expect(shuffled).toHaveLength(12);
    expect(new Set(shuffled.map((e) => e.glossId)).size).toBe(12);
  });

  it('is a pure function of the rng, and leaves its input alone', () => {
    const copy = [...entries];
    expect(shuffle(entries, testRng(5))).toEqual(shuffle(entries, testRng(5)));
    expect(shuffle(entries, testRng(5))).not.toEqual(entries);
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
      { id: 'c2', type: 'multiple_choice', vocab_term_id: 'l2', question: 'casa', options: ['בית', 'דלת'], correct_option: 0, context: null },
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

const saved = (glossId: string, key: string, variantId = `v-${glossId}`): SavedGloss => ({ glossId, key, variantId, savedAt: '', lexemeId: 'l', lemma: key, form: key, order: [0, 0] });
const rendering = (glossId: string, variantId: string, gloss: string, senseId = 's1', form = variantId): GlossRendering => ({
  glossId, senseId, variantId, form, gloss, rank: 0,
});

describe('askableRenderings (spec D12)', () => {
  const gloss = saved('g1', 'אצבע', 'v_fingers');

  it('keeps every rendering whose own citation form is the key, the lemma form among them', () => {
    const options = askableRenderings(gloss, [rendering('g1', 'v_fingers', 'אצבע'), rendering('g1', 'v_finger', 'אצבע'), rendering('g2', 'v_toe', 'בוהן')]);
    expect(options.map((option) => option.variantId)).toEqual(['v_finger', 'v_fingers']);
  });

  it('drops a drifted rendering, but never the saved form', () => {
    const options = askableRenderings(gloss, [rendering('g1', 'v_fingers', 'אצבעות'), rendering('g1', 'v_digit', 'ספרה')]);
    expect(options.map((option) => option.variantId)).toEqual(['v_fingers']);
  });

  it('takes one of them uniformly under the injected rng', () => {
    const options = askableRenderings(gloss, [rendering('g1', 'v_fingers', 'אצבע'), rendering('g1', 'v_finger', 'אצבע')]);
    expect(pickRendering(options, () => 0)?.variantId).toBe('v_finger');
    expect(pickRendering(options, () => 0.99)?.variantId).toBe('v_fingers');
    expect(pickRendering([], () => 0)).toBeUndefined();
  });
});

// Phase 34 (spec D9). An alternative holds the card open for one more try.
describe('step, the second try', () => {
  const card = (id: string): TypedTranslationQuestion => ({ ...typedQuestion(id), alternatives: ['vetrata'] });
  const [t1, t2] = [card('t1'), card('t2')];
  const MEANING: Question = { id: 'm1', type: 'typed_meaning', vocab_term_id: 'l1', question: 'finestra', part_of_speech: 'noun', meaning: 'חלון', context: null };
  const SAY: Question = { ...card('s1'), type: 'say_translation' };

  function pendingOn(questions: Question[], questionId: string, text = 'vetrata'): SessionRecord {
    const outcome = step(makeRecord(questions), questionId, { text });
    if (outcome.status !== 'advanced') throw new Error(outcome.status);
    return outcome.record;
  }

  it('records an alternative as pending and holds the session on its card', () => {
    const outcome = step(makeRecord([t1, t2]), 't1', { text: 'vetrata' });
    if (outcome.status !== 'advanced') throw new Error(outcome.status);
    expect(outcome.recorded).toBe('answer');
    expect(outcome.record.answers[0]).toMatchObject({ verdict: 'alternative', is_correct: true, retry_state: 'pending' });
    expect(currentQuestion(outcome.record)).toBe(t1);
    expect(positionOf(outcome.record)).toEqual({ position: 1, total: 2 });
    expect(pendingRetryOf(outcome.record)).toEqual({ answer: 'vetrata', wording: 'word' });
  });

  it('does not complete the session on a pending last card', () => {
    const outcome = step(makeRecord([t1]), 't1', { text: 'vetrata' });
    if (outcome.status !== 'advanced') throw new Error(outcome.status);
    expect(outcome.justCompleted).toBe(false);
    expect(outcome.record).toMatchObject({ complete: false, status: 'ready' });
    expect(currentQuestion(outcome.record)).toBe(t1);
  });

  // Review Focus 1: a network retry of the first answer re-opens the second try.
  it('replays the first answer sent again, pending flag and all', () => {
    const pending = pendingOn([t1, t2], 't1');
    expect(step(pending, 't1', { text: 'vetrata' })).toEqual({ status: 'replayed', record: pending, justCompleted: false });
    expect(step(pending, 't1', { text: 'anything at all' })).toEqual({ status: 'replayed', record: pending, justCompleted: false });
  });

  it('resolves the retry as the first answer was judged, and moves on', () => {
    const outcome = step(pendingOn([t1, t2], 't1'), 't1', { text: 'finestra' }, { retry: true });
    if (outcome.status !== 'advanced') throw new Error(outcome.status);
    expect(outcome.recorded).toBe('retry');
    expect(outcome.record.answers).toHaveLength(1);
    expect(outcome.record.answers[0]).toEqual({
      question_id: 't1',
      is_correct: true,
      answer_string: 'vetrata',
      verdict: 'alternative',
      retry_state: 'resolved',
      retry_answer_string: 'finestra',
      retry_verdict: 'exact',
    });
    expect(currentQuestion(outcome.record)).toBe(t2);
    expect(positionOf(outcome.record)).toEqual({ position: 2, total: 2 });
    expect(pendingRetryOf(outcome.record)).toBeNull();
    expect(outcome.justCompleted).toBe(false);
  });

  // Review Focus 2: the last card completes only when its retry resolves.
  it("completes the session when the last card's retry resolves", () => {
    const outcome = step(pendingOn([t1], 't1'), 't1', { text: 'finestar' }, { retry: true });
    if (outcome.status !== 'advanced') throw new Error(outcome.status);
    expect(outcome.justCompleted).toBe(true);
    expect(outcome.record).toMatchObject({ complete: true, status: 'completed' });
    expect(outcome.record.answers[0]).toMatchObject({ retry_state: 'resolved', retry_verdict: 'near_miss' });
  });

  it('records an empty retry, and show the answer, as given up', () => {
    const typed = step(pendingOn([t1, t2], 't1'), 't1', { text: '' }, { retry: true });
    if (typed.status !== 'advanced') throw new Error(typed.status);
    expect(typed.record.answers[0]).toMatchObject({ is_correct: true, retry_answer_string: '', retry_verdict: 'gave_up' });
    const spoken = step(pendingOn([SAY, t2], 's1'), 's1', { pass: 'show_answer' }, { retry: true });
    if (spoken.status !== 'advanced') throw new Error(spoken.status);
    expect(spoken.record.answers[0]).toMatchObject({ retry_answer_string: '', retry_verdict: 'gave_up' });
  });

  it("takes a spoken card's retry by voice or typed, and an unheard retry records nothing", () => {
    const pending = step(makeRecord([SAY, t2]), 's1', { heard: 'vetrata' });
    if (pending.status !== 'advanced') throw new Error(pending.status);
    expect(pending.record.answers[0]).toMatchObject({ verdict: 'alternative', retry_state: 'pending' });
    expect(step(pending.record, 's1', { heard: 'cane' }, { retry: true })).toEqual({ status: 'unheard' });
    expect(step(pending.record, 's1', { heard: 'la finestra' }, { retry: true })).toMatchObject({ status: 'advanced', recorded: 'retry' });
    const typed = step(pending.record, 's1', { text: 'finestra' }, { retry: true });
    if (typed.status !== 'advanced') throw new Error(typed.status);
    expect(typed.record.answers[0]).toMatchObject({ retry_answer_string: 'finestra', retry_verdict: 'exact' });
  });

  it('checks the kind of a retry as of a first answer', () => {
    expect(step(pendingOn([t1, t2], 't1'), 't1', { option_index: 0 }, { retry: true })).toEqual({ status: 'wrong_answer_kind' });
  });

  it('replays a retry sent again, and a first answer sent after it, without judging either', () => {
    const resolved = step(pendingOn([t1, t2], 't1'), 't1', { text: 'finestra' }, { retry: true });
    if (resolved.status !== 'advanced') throw new Error(resolved.status);
    expect(step(resolved.record, 't1', { text: 'porta' }, { retry: true })).toEqual({ status: 'replayed', record: resolved.record, justCompleted: false });
    expect(step(resolved.record, 't1', { text: 'vetrata' })).toEqual({ status: 'replayed', record: resolved.record, justCompleted: false });
  });

  it("replays a completed session's resolved last card, and refuses a retry where none was resolved", () => {
    const done = step(pendingOn([t1], 't1'), 't1', { text: 'finestra' }, { retry: true });
    if (done.status !== 'advanced') throw new Error(done.status);
    expect(step(done.record, 't1', { text: 'x' }, { retry: true })).toMatchObject({ status: 'replayed' });
    const plain = step(makeRecord([t1]), 't1', { text: 'finestra' });
    if (plain.status !== 'advanced') throw new Error(plain.status);
    expect(step(plain.record, 't1', { text: 'x' }, { retry: true })).toEqual({ status: 'invalid_question' });
  });

  it('refuses a retry where nothing is pending, and any other card while one is', () => {
    expect(step(makeRecord([t1, t2]), 't1', { text: 'finestra' }, { retry: true })).toEqual({ status: 'invalid_question' });
    const answered = step(makeRecord([t1, t2]), 't1', { text: 'finestra' });
    if (answered.status !== 'advanced') throw new Error(answered.status);
    expect(step(answered.record, 't1', { text: 'finestra' }, { retry: true })).toEqual({ status: 'invalid_question' });
    const pending = pendingOn([t1, t2], 't1');
    expect(step(pending, 't2', { text: 'finestra' })).toEqual({ status: 'invalid_question' });
    expect(step(pending, 't2', { text: 'finestra' }, { retry: true })).toEqual({ status: 'invalid_question' });
  });

  it('asks for the other meaning on a typed meaning card, and the other word elsewhere', () => {
    const outcome = step(makeRecord([MEANING]), 'm1', { text: 'שמשה', judged: 'alternative' });
    if (outcome.status !== 'advanced') throw new Error(outcome.status);
    expect(pendingRetryOf(outcome.record)).toEqual({ answer: 'שמשה', wording: 'meaning' });
    expect(pendingRetryOf(makeRecord([t1]))).toBeNull();
  });

  it('scores the first answer, whatever the retry came to', () => {
    const wrong = step(pendingOn([t1], 't1'), 't1', { text: 'porta' }, { retry: true });
    if (wrong.status !== 'advanced') throw new Error(wrong.status);
    expect(sessionScore(wrong.record)).toEqual({ correct: 1, total: 1 });
    expect(missedQuestions(wrong.record)).toEqual([]);
  });
});

// Phase 39 (spec D7, D10). A typed answer in the wrong alphabet is refused, nothing recorded.
describe('step, the wrong alphabet', () => {
  const card = typedQuestion('t1');
  const next = typedQuestion('t2');
  const typed: Record<string, [Question, string]> = {
    typed_translation: [card, 'חלון'],
    say_translation: [{ ...card, type: 'say_translation' }, 'חלון'],
    dictation: [{ id: 't1', type: 'dictation', vocab_term_id: 'v', question: 'finestra', meaning: 'חלון' }, 'חלון'],
    cloze_typed: [
      { id: 't1', type: 'cloze_typed', vocab_term_id: 'v', sentence: 'La finestra', gap: { start: 3, end: 11 }, translation: 'החלון', meaning: 'חלון', answer: 'finestra', alternatives: [], mark: null },
      'חלון',
    ],
    sentence_translation: [
      { id: 't1', type: 'sentence_translation', vocab_term_id: 'v', question: 'החלון פתוח', meaning: 'חלון', sentence: 'The window is open', gap: { start: 4, end: 10 }, answer: 'window', mark: null },
      'חלון',
    ],
    typed_meaning: [{ id: 't1', type: 'typed_meaning', vocab_term_id: 'v', question: 'finestra', part_of_speech: 'noun', meaning: 'חלון', context: null }, 'window'],
  };

  it.each(Object.keys(typed))('refuses a %s answered in the wrong alphabet', (type) => {
    const [question, text] = typed[type];
    // The judged cards take the text the server already judged; the rest take it bare.
    const answer = type === 'typed_meaning' || type === 'sentence_translation' ? { text, judged: 'exact' as const } : { text };
    expect(step(makeRecord([question, next]), 't1', answer)).toEqual({ status: 'wrong_script' });
  });

  it('refuses a second try in the wrong alphabet like a first answer', () => {
    const open = { ...card, alternatives: ['vetrata'] };
    const first = step(makeRecord([open, next]), 't1', { text: 'vetrata' });
    if (first.status !== 'advanced') throw new Error(first.status);
    expect(step(first.record, 't1', { text: 'חלון' }, { retry: true })).toEqual({ status: 'wrong_script' });
  });

  it('does not refuse digits, punctuation, whitespace or an empty text', () => {
    expect(step(makeRecord([card, next]), 't1', { text: '1990' })).toMatchObject({ status: 'advanced' });
    expect(step(makeRecord([card, next]), 't1', { text: '...' })).toMatchObject({ status: 'advanced' });
    expect(step(makeRecord([card, next]), 't1', { text: '' })).toMatchObject({ status: 'advanced' });
    // On a pending second try an empty text still gives up.
    const open = { ...card, alternatives: ['vetrata'] };
    const first = step(makeRecord([open, next]), 't1', { text: 'vetrata' });
    if (first.status !== 'advanced') throw new Error(first.status);
    const gaveUp = step(first.record, 't1', { text: '' }, { retry: true });
    if (gaveUp.status !== 'advanced') throw new Error(gaveUp.status);
    expect(gaveUp.record.answers[0].retry_verdict).toBe('gave_up');
  });

  it('ignores a choice card and a letter-tile card', () => {
    const q0 = makeQuestion(0);
    expect(step(makeRecord([q0]), q0.id, { option_index: 0 })).toMatchObject({ status: 'advanced' });
    const tiles = { id: 'l1', type: 'letter_tiles', vocab_term_id: 'v', question: 'חלון', answer: 'finestra', tiles: ['f'] } as unknown as Question;
    expect(step(makeRecord([tiles]), 'l1', { text: 'חלון' })).not.toEqual({ status: 'wrong_script' });
  });
});

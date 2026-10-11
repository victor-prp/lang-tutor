import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { z } from 'zod';
import type { QuestionSchema } from '@lang-tutor/core/api/schemas';
import type { Dimension } from '@lang-tutor/core/domain';

import { rngFor } from './rng.ts';
import { decide, matchCard, type Behaviour, type SavedWord } from './answer.ts';
import type { BotMemory } from './memory.ts';

type Card = z.infer<typeof QuestionSchema>;

const saved: SavedWord[] = [
  { form: 'cat', meaning: 'חתול' },
  { form: 'dog', meaning: 'כלב' },
  { form: 'house', meaning: 'בית' },
];

/** A memory with a fixed recall, remembering what it was asked and taught. */
function memory(p: number) {
  const asked: Array<[string, Dimension]> = [];
  const m: BotMemory & { asked: typeof asked } = {
    asked,
    setTime() {},
    recall(word, dimension) {
      asked.push([word, dimension]);
      return p;
    },
    learn() {},
  };
  return m;
}

const calm: Behaviour = { slip: 0, gaveUp: 0 };
/** An rng that always draws `x`: 0.01 is under any recall chance worth the name, 0.99 over. */
const always = (x: number) => () => x;

const base = { id: 'q1', vocab_term_id: 't1' };
const mc: Card = {
  ...base,
  type: 'multiple_choice',
  question: 'cat',
  options: ['כלב', 'חתול', 'בית', 'סוס'],
  correct_option: 1,
};

test('a choice card answered right picks the correct option', () => {
  const d = decide(mc, memory(0.9), saved, always(0.01), calm);
  assert.deepEqual({ kind: d.kind, index: d.kind === 'option' ? d.index : -1 }, { kind: 'option', index: 1 });
  assert.equal(d.detail.word, 'cat');
  assert.equal(d.detail.outcome, 'right');
  assert.equal(d.detail.unmatched, false);
});

test('a choice card answered wrong picks one of the other options', () => {
  const picks = new Set<number>();
  for (const x of [0.99, 0.999, 0.9999]) {
    const d = decide(mc, memory(0), saved, (() => { const q = [0.99, x]; return () => q.shift() ?? x; })(), calm);
    assert.equal(d.kind, 'option');
    if (d.kind === 'option') picks.add(d.index);
    assert.equal(d.detail.outcome, 'wrong');
  }
  assert.ok(!picks.has(1) && picks.size > 0);
});

test('the guessing floor: a four-option card at recall 0 is still right a quarter of the time', () => {
  let right = 0;
  const rng = rngFor('floor', 1);
  for (let i = 0; i < 4000; i++) {
    const d = decide(mc, memory(0), saved, rng, calm);
    if (d.detail.outcome === 'right') right++;
  }
  assert.ok(right > 900 && right < 1100, `right ${right}`);
  // The draw is against guess(P) = 0.25 + 0.75 * 0.
  assert.equal(decide(mc, memory(0), saved, always(0.24), calm).detail.outcome, 'right');
  assert.equal(decide(mc, memory(0), saved, always(0.26), calm).detail.outcome, 'wrong');
});

test('a typed card has no floor: recall 0 is always wrong', () => {
  const typed: Card = {
    ...base,
    type: 'typed_translation',
    question: 'חתול',
    part_of_speech: 'noun',
    answer: 'cat',
    lemma: 'cat',
    alternatives: [],
  };
  assert.equal(decide(typed, memory(0), saved, always(0.01), calm).detail.outcome, 'wrong');
});

test('typed right gives the form, near miss on a slip draw', () => {
  const typed: Card = {
    ...base,
    type: 'typed_translation',
    question: 'חתול',
    part_of_speech: 'noun',
    answer: 'cat',
    lemma: 'cat',
    alternatives: [],
  };
  const right = decide(typed, memory(1), saved, always(0.01), calm);
  assert.deepEqual(right.kind === 'text' && right.text, 'cat');
  assert.equal(right.detail.word, 'cat');
  assert.equal(right.detail.outcome, 'right');
  const slip = decide(typed, memory(1), saved, always(0.01), { slip: 1, gaveUp: 0 });
  assert.equal(slip.detail.outcome, 'near_miss');
  assert.ok(slip.kind === 'text' && slip.text !== 'cat' && slip.text.length === 3);
});

test('typed wrong gives another saved word, or an empty answer when it gives up', () => {
  const typed: Card = {
    ...base,
    type: 'typed_translation',
    question: 'חתול',
    part_of_speech: 'noun',
    answer: 'cat',
    lemma: 'cat',
    alternatives: [],
  };
  const wrong = decide(typed, memory(0), saved, always(0.5), calm);
  assert.equal(wrong.detail.outcome, 'wrong');
  assert.ok(wrong.kind === 'text' && ['dog', 'house'].includes(wrong.text), JSON.stringify(wrong));
  const gaveUp = decide(typed, memory(0), saved, always(0.5), { slip: 0, gaveUp: 1 });
  assert.equal(gaveUp.detail.outcome, 'gave_up');
  assert.deepEqual(gaveUp.kind === 'text' && gaveUp.text, '');
});

test('reverse choice matches by the Hebrew prompt and tests both written dimensions', () => {
  const card: Card = {
    ...base,
    type: 'reverse_choice',
    question: 'כלב',
    part_of_speech: 'noun',
    options: ['cat', 'dog', 'house', 'horse'],
    correct_option: 1,
  };
  const m = memory(1);
  const d = decide(card, m, saved, always(0.01), calm);
  assert.equal(d.detail.word, 'dog');
  assert.deepEqual(d.detail.dimensions, ['written_receptive', 'written_productive']);
  assert.deepEqual(m.asked.map(([w]) => w), ['dog', 'dog']);
  assert.equal(d.kind === 'option' && d.index, 1);
});

test('the weakest tested dimension decides', () => {
  const m: BotMemory = {
    setTime() {},
    recall: (_w, dim) => (dim === 'written_productive' ? 0 : 1),
    learn() {},
  };
  const card: Card = {
    ...base,
    type: 'typed_translation',
    question: 'חתול',
    part_of_speech: 'noun',
    answer: 'cat',
    lemma: 'cat',
    alternatives: [],
  };
  const d = decide(card, m, saved, always(0.5), calm);
  assert.equal(d.detail.p, 0);
  assert.equal(d.detail.outcome, 'wrong');
});

test('cloze cards match by the marked word, and dictation and listening by the spoken form', () => {
  const cloze: Card = {
    ...base,
    type: 'cloze_choice',
    sentence: 'The ___ sleeps.',
    gap: { start: 4, end: 7 },
    translation: 'x',
    meaning: 'חתול',
    options: ['dog', 'cat', 'house', 'horse'],
    correct_option: 1,
  };
  assert.equal(matchCard(cloze, saved)?.form, 'cat');
  const clozeFilled: Card = { ...cloze, sentence: 'The dog sleeps.', meaning: 'x' };
  assert.equal(matchCard(clozeFilled, saved)?.form, 'dog');
  const dictation: Card = { ...base, type: 'dictation', question: 'house', meaning: 'בית' };
  assert.equal(matchCard(dictation, saved)?.form, 'house');
  const listen: Card = { ...base, type: 'listen_choice', question: 'Dog', options: ['כלב', 'חתול', 'בית', 'סוס'], correct_option: 0 };
  assert.equal(matchCard(listen, saved)?.form, 'dog');
  const st: Card = {
    ...base,
    type: 'sentence_translation',
    question: 'החתול ישן',
    meaning: 'חתול',
    sentence: 'The cat sleeps.',
    gap: { start: 4, end: 7 },
    answer: 'cat',
  };
  assert.equal(matchCard(st, saved)?.form, 'cat');
});

test('a dictation card is typed from the form', () => {
  const card: Card = { ...base, type: 'dictation', question: 'house', meaning: 'בית' };
  const d = decide(card, memory(1), saved, always(0.01), calm);
  assert.deepEqual(d.kind === 'text' && d.text, 'house');
  assert.deepEqual(d.detail.dimensions, ['spoken_receptive', 'spelling']);
});

test('a matching card answers its own word', () => {
  const card: Card = {
    ...base,
    type: 'matching',
    question: 'dog',
    options: ['חתול', 'כלב', 'בית', 'סוס', 'עץ'],
    correct_option: 1,
    board: { question_ids: ['a', 'b', 'c', 'd'], words: ['cat', 'dog', 'house', 'horse'], correct_options: [0, 1, 2, 3] },
  };
  const d = decide(card, memory(1), saved, always(0.01), calm);
  assert.equal(d.kind === 'option' && d.index, 1);
  assert.equal(d.detail.word, 'dog');
});

test('speaking: right says the word, wrong says another, gave up asks to see the answer', () => {
  const card: Card = {
    ...base,
    type: 'say_translation',
    question: 'חתול',
    part_of_speech: 'noun',
    answer: 'cat',
    lemma: 'cat',
    alternatives: [],
  };
  const right = decide(card, memory(1), saved, always(0.01), calm);
  assert.deepEqual(right.kind === 'speak' && right.word, 'cat');
  const wrong = decide(card, memory(0), saved, always(0.5), calm);
  assert.ok(wrong.kind === 'speak' && ['dog', 'house'].includes(wrong.word));
  assert.equal(wrong.detail.outcome, 'wrong');
  const gave = decide(card, memory(0), saved, always(0.5), { slip: 0, gaveUp: 1 });
  assert.deepEqual(gave.kind === 'pass' && gave.pass, 'show_answer');
  assert.equal(gave.detail.outcome, 'gave_up');
});

test('read aloud says the word and needs no recall', () => {
  const card: Card = { ...base, type: 'read_aloud', question: 'dog', meaning: 'כלב' };
  const m = memory(0);
  const d = decide(card, m, saved, always(0.99), calm);
  assert.deepEqual(d.kind === 'speak' && d.word, 'dog');
  assert.equal(m.asked.length, 0);
});

test('typed meaning types the saved Hebrew meaning', () => {
  const card: Card = { ...base, type: 'typed_meaning', question: 'cat', part_of_speech: 'noun', meaning: 'חתול' };
  const d = decide(card, memory(1), saved, always(0.01), { slip: 1, gaveUp: 0 });
  assert.deepEqual(d.kind === 'text' && d.text, 'חתול');
});

test('an unmatchable card is marked unmatched and answered at random', () => {
  const card: Card = { ...mc, question: 'zebra' };
  const m = memory(1);
  const d = decide(card, m, saved, always(0.5), calm);
  assert.equal(d.detail.unmatched, true);
  assert.equal(d.detail.word, null);
  assert.equal(d.detail.outcome, 'unmatched');
  assert.equal(d.kind, 'option');
  assert.equal(m.asked.length, 0);
  const typed: Card = { ...base, type: 'typed_translation', question: 'זברה', part_of_speech: 'noun', answer: 'zebra', lemma: 'zebra', alternatives: [] };
  const t = decide(typed, memory(1), saved, always(0.5), calm);
  assert.equal(t.detail.unmatched, true);
  assert.equal(t.kind, 'text');
});

test('the same inputs and rng give the same decision', () => {
  const rngA = (() => { let i = 0; return () => ((i++ * 0.37) % 1); })();
  const rngB = (() => { let i = 0; return () => ((i++ * 0.37) % 1); })();
  assert.deepEqual(decide(mc, memory(0.5), saved, rngA, calm), decide(mc, memory(0.5), saved, rngB, calm));
});

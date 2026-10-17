import { describe, expect, it } from '@jest/globals';

import type { QuestionType } from '@lang-tutor/core/domain';

import {
  ASKED_DISTRACTORS,
  DISTRACTOR_MARKER,
  MAX_ALTERNATIVES,
  MAX_CARD_ALTERNATIVES,
  NOTHING_GENERATED,
  NO_EXTRAS,
  boardMeanings,
  buildDistractorPrompt,
  distractorItems,
  generatedContent,
  optionsFor,
  parseLlmDistractors,
  taskFor,
  tasksFor,
  validateDistractors,
  withSiblingAlternatives,
  knownWords,
  nothingKnown,
  type GenerationContext,
  type KnownRight,
  type RecentSentences,
} from './distractors';
import type { SessionPlan } from './plan';

const NO_RECENT: RecentSentences = new Map();
/** Phase 34 (spec D3). A batch the dictionary knows nothing more about. */
const NONE = nothingKnown();
// A card of any type but the six that ask for an answer form (phase 34) has neither a sentence nor one.
const NO_SENTENCE = { sentence: null, sentenceTranslation: null, gapStart: null, gapEnd: null, answerForm: null };

/** Items for today's card only, as every batch was before phase 23. */
const meaningItems = (context: GenerationContext[]) =>
  distractorItems(context, context.map((): QuestionType => 'multiple_choice').map(taskFor), NO_RECENT);

const CONTEXT: GenerationContext[] = [
  { glossId: 'g-s1', senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
  { glossId: 'g-s2', senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
];
const ITEMS = meaningItems(CONTEXT);

describe('distractorItems', () => {
  it('keys items q1, q2, … in input order', () => {
    expect(ITEMS.map((item) => item.key)).toEqual(['q1', 'q2']);
    expect(ITEMS[1]).toMatchObject({ form: 'лук', translation: 'בצל' });
  });
});

describe('buildDistractorPrompt for Italian', () => {
  it('names Italian and Hebrew', () => {
    const prompt = buildDistractorPrompt({ items: ITEMS, from: 'it', to: 'he', others: [] });
    expect(prompt.system).toContain('Italian');
    expect(prompt.system).toContain('Hebrew');
  });
});

describe('buildDistractorPrompt', () => {
  const prompt = buildDistractorPrompt({ items: ITEMS, from: 'ru', to: 'he', others: [] });

  it('names the languages and carries the marker MockServer matches on', () => {
    expect(prompt.system).toContain('Russian');
    expect(prompt.system).toContain('Hebrew');
    expect(prompt.system).toContain(DISTRACTOR_MARKER);
  });

  it('tells the model that items sharing a word must not offer each other’s answers', () => {
    expect(prompt.system).toContain('share a word');
  });

  // Review: the validator refuses, on a reversed card, another saved word with
  // the same meaning. Unstated, a refusal would repeat on every retry.
  it('tells the model that items sharing a meaning must not offer each other’s words', () => {
    expect(prompt.system).toContain('share a meaning');
  });

  it('carries the target writing rules: no nikud in Hebrew', () => {
    expect(prompt.system).toContain('no nikud');
  });

  it('sends every item with its key, form and correct answer', () => {
    const sent = JSON.parse(prompt.user) as { items: { key: string; word: string; correct: string }[] };
    expect(sent.items).toEqual([
      expect.objectContaining({ key: 'q1', word: 'прочитала', correct: 'קראה' }),
      expect.objectContaining({ key: 'q2', word: 'лук', correct: 'בצל' }),
    ]);
  });

  it('refuses a language it does not know', () => {
    expect(() => buildDistractorPrompt({ items: ITEMS, from: 'xx', to: 'he', others: [] })).toThrow('xx');
  });
});

describe('parseLlmDistractors', () => {
  const good = { items: [{ key: 'q1', distractors: ['a', 'b', 'c'] }] };

  it('reads plain and fenced JSON', () => {
    expect(parseLlmDistractors(JSON.stringify(good))).toEqual(good);
    expect(parseLlmDistractors('```json\n' + JSON.stringify(good) + '\n```')).toEqual(good);
  });

  it('answers null for junk and for the wrong shape', () => {
    expect(parseLlmDistractors('not json')).toBeNull();
    expect(
      parseLlmDistractors(JSON.stringify({ items: [{ key: 'q1', distractors: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }] })),
    ).toBeNull();
    expect(parseLlmDistractors(JSON.stringify({ items: [{ distractors: [] }] }))).toBeNull();
  });

  // Phase 38 (spec D2). A typed gap asks for ten, the schema's cap: one more must
  // cost the surplus, never the session.
  it('keeps the first ten alternatives of a longer list rather than refusing the answer', () => {
    const many = Array.from({ length: 12 }, (_, index) => `word${index}`);
    const parsed = parseLlmDistractors(JSON.stringify({ items: [{ key: 'q1', distractors: [], alternatives: many }] }));
    expect(parsed?.items[0].alternatives).toEqual(many.slice(0, 10));
  });

  // Phase 23, Review Focus 4: null is how structured output spells "none", and
  // a typed item has no wrong options to give. Neither may fail the parse; the
  // per-task validation decides what an empty list costs.
  it('reads a null or missing list as an empty one', () => {
    expect(parseLlmDistractors(JSON.stringify({ items: [{ key: 'q3', distractors: [], alternatives: null }] }))).toEqual({
      items: [{ key: 'q3', distractors: [] }],
    });
    expect(parseLlmDistractors(JSON.stringify({ items: [{ key: 'q3', alternatives: ['big'] }] }))).toEqual({
      items: [{ key: 'q3', distractors: [], alternatives: ['big'] }],
    });
    expect(parseLlmDistractors(JSON.stringify({ items: [{ key: 'q3', distractors: null, alternatives: ['big'] }] }))).toEqual({
      items: [{ key: 'q3', distractors: [], alternatives: ['big'] }],
    });
  });
});

// Phase 34 (spec D4a; ruling R8). Six wrong options are read; the context fields
// left the batch for their own call, so an answer that still carries them keeps
// its options and loses only those fields.
describe('parseLlmDistractors with the phase 34 shape', () => {
  it('reads six wrong options', () => {
    const item = { key: 'q1', distractors: ['a', 'b', 'c', 'd', 'e', 'f'] };
    expect(parseLlmDistractors(JSON.stringify({ items: [item] }))).toEqual({ items: [item] });
  });

  it('drops a context field instead of failing the batch', () => {
    const raw = { items: [{ key: 'q1', distractors: ['a', 'b', 'c'], context: 'Parlo con mia madre.', context_word: null, sentence_word: 'מדבר' }] };
    expect(parseLlmDistractors(JSON.stringify(raw))).toEqual({ items: [{ key: 'q1', distractors: ['a', 'b', 'c'] }] });
  });
});

describe('validateDistractors', () => {
  const answer = (q1: string[], q2: string[] = ['קשת', 'שום', 'גזר']) => ({
    items: [
      { key: 'q1', distractors: q1 },
      { key: 'q2', distractors: q2 },
    ],
  });

  it('accepts three distinct wrong answers per item, trimmed', () => {
    const verdict = validateDistractors(ITEMS, answer([' כתבה', 'שמעה', 'ראתה ']), 'he', [], 'ru', NONE);
    expect(verdict).toEqual({
      byKey: new Map([
        ['q1', { ...NOTHING_GENERATED, distractors: ['כתבה', 'שמעה', 'ראתה'] }],
        ['q2', { ...NOTHING_GENERATED, distractors: ['קשת', 'שום', 'גזר'] }],
      ]),
      refused: new Map(),
    });
  });

  it('ignores keys nobody asked for', () => {
    const verdict = validateDistractors(ITEMS, {
      items: [...answer(['כתבה', 'שמעה', 'ראתה']).items, { key: 'q9', distractors: ['x', 'y', 'z'] }],
    }, 'he', [], 'ru', NONE);
    expect(verdict.refused.size).toBe(0);
  });

  it('refuses an item with no answer', () => {
    const verdict = validateDistractors(ITEMS, { items: [{ key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] }] }, 'he', [], 'ru', NONE);
    expect(verdict.refused.get('q2')).toBe('no answer for q2');
  });

  it('phase 48 (spec D1): refuses only the item that fails, and keeps the others', () => {
    // ITEMS' q1 fails (two usable of three); q2 keeps its options.
    const verdict = validateDistractors(ITEMS, answer(['כתבה', 'שמעה']), 'he', [], 'ru', NONE);
    expect([...verdict.refused.keys()]).toEqual(['q1']);
    expect(verdict.refused.get('q1')).toBe('q1 needs three non-empty wrong answers');
    expect(verdict.byKey.has('q1')).toBe(false);
    expect(verdict.byKey.has('q2')).toBe(true);
  });

  it('phase 48 (spec D1): a typed item the model did not answer keeps no alternatives', () => {
    const typed = distractorItems(CONTEXT, ['typed', 'meaning'], NO_RECENT);
    const verdict = validateDistractors(typed, { items: [{ key: 'q2', distractors: ['קשת', 'שום', 'גזר'] }] }, 'he', [], 'ru', NONE);
    expect(verdict.refused.size).toBe(0);
    expect(verdict.byKey.get('q1')).toEqual({ ...NOTHING_GENERATED, alternatives: [] });
    expect(verdict.byKey.has('q2')).toBe(true);
  });

  it('refuses fewer than three wrong answers on a choice item', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', 'שמעה']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
  });

  it('refuses an empty distractor', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', '  ', 'ראתה']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
  });

  // Review Focus 4: the right answer in disguise.
  it.each([['קראה'], ['קראה '], ['קראה.']])('refuses the correct answer as a distractor: %j', (disguised) => {
    expect(validateDistractors(ITEMS, answer(['כתבה', disguised, 'ראתה']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
  });

  it('refuses two equal distractors', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', 'כתבה', 'ראתה']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
  });

  // The comparison is the validator's own: a multi-word answer keeps its mark
  // in a dictionary key, but here "the same option" ignores it, and nikud.
  describe('multi-word answers and pointed copies', () => {
    const phrase = meaningItems([
      { glossId: 'g-s3', senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'большое спасибо', lemma: 'спасибо', partOfSpeech: 'phrase', translation: 'תודה רבה', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
    ]);
    const one = (distractors: string[]) => ({ items: [{ key: 'q1', distractors }] });

    it.each([['תודה רבה.'], ['תודה רבה!'], ['תודה  רבה'], ['תודה רבה…'], ['תודה רבה?!']])(
      'refuses the multi-word answer in disguise: %j',
      (disguised) => {
        expect(validateDistractors(phrase, one(['כתבה', disguised, 'ראתה']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
      },
    );

    it('accepts a different multi-word option', () => {
      expect(validateDistractors(phrase, one(['בבקשה רבה', 'להתראות', 'ערב טוב']), 'he', [], 'ru', NONE).refused.size).toBe(0);
    });

    it('refuses a pointed copy of the answer', () => {
      expect(validateDistractors(ITEMS, answer(['כתבה', 'קָרָאָה', 'ראתה']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
    });

    it('counts two distractors that differ only in points, marks or spacing as equal', () => {
      expect(validateDistractors(phrase, one(['כתבה', 'כָּתְבָה', 'כתבה.']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
      expect(validateDistractors(phrase, one(['שמעה רבה', 'שמעה  רבה!', 'ראתה']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
    });
  });

  // Review: save-all stores every sense of a word, so one batch can hold the
  // same form twice. One sense's translation is a right answer on the other.
  describe('another saved meaning of the same word', () => {
    const polysemy = meaningItems([
      { glossId: 'g-s1', senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
      { glossId: 'g-s2', senseId: 's2', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'קשת', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
      { glossId: 'g-s3', senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'хлеб', lemma: 'хлеб', partOfSpeech: 'noun', translation: 'לחם', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
    ]);
    const batch = (q1: string[], q3: string[] = ['חלב', 'גבינה', 'ביצה']) => ({
      items: [
        { key: 'q1', distractors: q1 },
        { key: 'q2', distractors: ['שום', 'גזר', 'תפוח'] },
        { key: 'q3', distractors: q3 },
      ],
    });

    it('refuses a distractor that is the other sense’s translation, even in disguise', () => {
      for (const offered of ['קשת', 'קשת.', 'קֶשֶׁת']) {
        const verdict = validateDistractors(polysemy, batch(['חציל', offered, 'מלפפון']), 'he', [], 'ru', NONE);
        expect(verdict.refused.size).toBeGreaterThan(0);
        expect(verdict.refused.get('q1')).toContain('q1');
      }
    });

    it('accepts the same text on an item of a different word', () => {
      expect(validateDistractors(polysemy, batch(['חציל', 'מלפפון', 'עגבניה'], ['קשת', 'חלב', 'ביצה']), 'he', [], 'ru', NONE).refused.size).toBe(0);
    });
  });
});

// Review: the script a reversed card's wrong options must avoid is the
// explanation language's, not Hebrew's. A legacy learner of Hebrew explained
// in English gets Hebrew options and English prompts.
describe('a learner of Hebrew explained in English', () => {
  const HEBREW_WORDS: GenerationContext[] = [
    { glossId: 'g-s1', senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'ספר', lemma: 'ספר', partOfSpeech: 'noun', translation: 'book', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
    { glossId: 'g-s2', senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'חלון', lemma: 'חלון', partOfSpeech: 'noun', translation: 'window', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
  ];
  const items = distractorItems(HEBREW_WORDS, (['reverse_choice', 'typed_translation'] as QuestionType[]).map(taskFor), NO_RECENT);

  it('accepts Hebrew wrong words and refuses English ones', () => {
    const reply = (q1: string[]) => ({ items: [{ key: 'q1', distractors: q1 }, { key: 'q2', distractors: [] }] });
    expect(validateDistractors(items, reply(['עט', 'דף', 'שולחן']), 'en', [], 'ru', NONE).refused.size).toBe(0);
    expect(validateDistractors(items, reply(['עט', 'pen', 'שולחן']), 'en', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
  });

  it('keeps Hebrew alternatives and drops English ones', () => {
    const verdict = validateDistractors(
      items,
      { items: [{ key: 'q1', distractors: ['עט', 'דף', 'שולחן'] }, { key: 'q2', distractors: [], alternatives: ['אשנב', 'pane'] }] },
      'en',
      [],
      'ru',
      NONE,
    );
    expect(verdict.byKey.get('q2')!.alternatives).toEqual(['אשנב']);
  });
});

describe('optionsFor', () => {
  it('puts the correct option at canonical position 0', () => {
    expect(optionsFor('קראה', ['כתבה', 'שמעה', 'ראתה'])).toEqual([
      { position: 0, text: 'קראה', is_correct: true },
      { position: 1, text: 'כתבה', is_correct: false },
      { position: 2, text: 'שמעה', is_correct: false },
      { position: 3, text: 'ראתה', is_correct: false },
    ]);
  });
});

// Phase 23 (spec D8): three tasks in one call.
describe('three tasks', () => {
  const CONTEXT3: GenerationContext[] = [
    ...CONTEXT,
    { glossId: 'g-s3', senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
  ];
  const TYPES: QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];
  const MIXED = distractorItems(CONTEXT3, TYPES.map(taskFor), NO_RECENT);
  const reply = (q2: string[], q3: { distractors?: string[]; alternatives?: string[] } = {}) => ({
    items: [
      { key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] },
      { key: 'q2', distractors: q2 },
      { key: 'q3', distractors: q3.distractors ?? [], ...(q3.alternatives ? { alternatives: q3.alternatives } : {}) },
    ],
  });

  it('names each item’s task', () => {
    expect(MIXED.map((item) => item.task)).toEqual(['meaning', 'word', 'typed']);
  });

  it('sends the task with every item, and both languages’ writing rules', () => {
    const prompt = buildDistractorPrompt({ items: MIXED, from: 'ru', to: 'he', others: [] });
    const sent = JSON.parse(prompt.user) as { items: { key: string; task: string }[] };
    expect(sent.items.map((item) => item.task)).toEqual(['meaning', 'word', 'typed']);
    expect(prompt.system).toContain(DISTRACTOR_MARKER);
    expect(prompt.system).toContain('no nikud');
    expect(prompt.system).toContain('Write Russian without stress marks');
    expect(prompt.system).toContain('alternatives');
  });

  it('accepts three target-language wrong words on a word item', () => {
    const verdict = validateDistractors(MIXED, reply(['чеснок', 'морковь', 'капуста']), 'he', [], 'ru', NONE);
    expect(verdict.refused.size).toBe(0);
    expect(verdict.byKey.get('q2')).toEqual({ ...NOTHING_GENERATED, distractors: ['чеснок', 'морковь', 'капуста'] });
  });

  it('refuses Hebrew, or the word itself, among a word item’s wrong options', () => {
    expect(validateDistractors(MIXED, reply(['чеснок', 'בצל', 'капуста']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
    expect(validateDistractors(MIXED, reply(['чеснок', 'лук', 'капуста']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
    expect(validateDistractors(MIXED, reply(['чеснок', 'Лук.', 'капуста']), 'he', [], 'ru', NONE).refused.size).toBeGreaterThan(0);
  });

  it('refuses, on a word item, another item’s word that has the same meaning', () => {
    const same = distractorItems(
      [
        { glossId: 'g-a', senseId: 'a', variantId: 'va', lexemeId: 'la', form: 'bella', lemma: 'bello', partOfSpeech: 'adjective', translation: 'יפה', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
        { glossId: 'g-b', senseId: 'b', variantId: 'vb', lexemeId: 'lb', form: 'carina', lemma: 'carino', partOfSpeech: 'adjective', translation: 'יפה', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null },
      ],
      ['word', 'word'],
      NO_RECENT,
    );
    const verdict = validateDistractors(same, {
      items: [
        { key: 'q1', distractors: ['brutta', 'carina', 'alta'] },
        { key: 'q2', distractors: ['brutta', 'bassa', 'alta'] },
      ],
    }, 'he', [], 'ru', NONE);
    expect(verdict.refused.size).toBeGreaterThan(0);
  });

  // Review Focus 4: alternatives may be missing or messy; never fail a session.
  it('accepts a typed item with no alternatives key, and ignores its distractors', () => {
    const verdict = validateDistractors(MIXED, reply(['чеснок', 'морковь', 'капуста'], { distractors: ['a', 'b', 'c'] }), 'he', [], 'ru', NONE);
    expect(verdict.refused.size).toBe(0);
    expect(verdict.byKey.get('q3')).toEqual(NOTHING_GENERATED);
  });

  it('cleans a typed item’s alternatives instead of refusing them', () => {
    const verdict = validateDistractors(
      MIXED,
      reply(['чеснок', 'морковь', 'капуста'], {
        alternatives: [' скоро ', '', 'מהר', 'быстро', 'Скоро', 'живо', 'шибко', 'резво', 'стремительно', 'проворно'],
      }),
      'he',
      [],
      'ru',
      NONE,
    );
    expect(verdict.refused.size).toBe(0);
    expect(verdict.byKey.get('q3')!.alternatives).toEqual(['скоро', 'живо', 'шибко', 'резво', 'стремительно']);
    expect(verdict.byKey.get('q3')!.alternatives).toHaveLength(MAX_ALTERNATIVES);
  });

  it('builds each type’s stored content', () => {
    const generated = { ...NOTHING_GENERATED, distractors: ['a', 'b', 'c'], alternatives: ['x'] };
    expect(generatedContent(CONTEXT3[0], 'multiple_choice', generated, NO_EXTRAS)).toEqual({
      prompt: null,
      options: optionsFor('קראה', ['a', 'b', 'c']),
      alternatives: null,
      tiles: null,
      ...NO_SENTENCE,
    });
    expect(generatedContent(CONTEXT3[1], 'reverse_choice', generated, NO_EXTRAS)).toEqual({
      prompt: 'בצל',
      options: optionsFor('лук', ['a', 'b', 'c']),
      alternatives: null,
      tiles: null,
      ...NO_SENTENCE,
    });
    expect(generatedContent(CONTEXT3[2], 'typed_translation', generated, NO_EXTRAS)).toEqual({
      prompt: 'מהר',
      options: null,
      alternatives: ['x'],
      tiles: null,
      ...NO_SENTENCE,
    });
  });
});

describe('phase 24 generation (spec D2, D10)', () => {
  it('asks nothing for a dictation, a tiles card or a board word but the first', () => {
    expect(taskFor('dictation')).toBeNull();
    expect(taskFor('letter_tiles')).toBeNull();
    expect(taskFor('matching')).toBeNull();
    expect(taskFor('listen_choice')).toBe('meaning');
    const plan: SessionPlan = {
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      types: [
        'multiple_choice', 'reverse_choice', 'typed_translation',
        'matching', 'matching', 'matching', 'matching',
        'listen_choice', 'letter_tiles', 'dictation',
      ],
      intro: Array(10).fill(false),
      board: { start: 3 },
    };
    expect(tasksFor(plan)).toEqual(['meaning', 'word', 'typed', 'meaning', null, null, null, 'meaning', null, null]);
  });

  it('keys an item by its position, whichever positions ask nothing', () => {
    const rows = ['a', 'b', 'c'].map((form) => ({ ...CONTEXT[0], form, lemma: form }));
    expect(distractorItems(rows, ['meaning', null, 'typed'], NO_RECENT).map((item) => item.key)).toEqual(['q1', 'q3']);
  });

  const row = (form: string, translation: string): GenerationContext => ({
    glossId: `g-s-${form}-${translation}`, senseId: `s-${form}-${translation}`, variantId: `v-${form}`, lexemeId: `l-${form}`, form, lemma: form, partOfSpeech: 'noun', translation, example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null,
  });

  it("takes a board's fifth meaning from the first wrong one that is none of its four", () => {
    const board = [row('a', 'בית'), row('b', 'דלי'), row('c', 'עץ'), row('d', 'סיר')];
    expect(boardMeanings(board, board, ['דלי', 'שולחן', 'כיסא'], NONE)).toEqual(['בית', 'דלי', 'עץ', 'סיר', 'שולחן']);
    expect(boardMeanings(board, board, ['בית ', 'דלי', 'עץ'], NONE)).toBeNull();
  });

  // Review (final), reproduction (b): a board word's other saved meaning is
  // not a wrong meaning for the board's fifth place.
  it("never takes a board word's other saved meaning as the fifth meaning", () => {
    const board = [row('замок', 'טירה'), row('b', 'דלי'), row('c', 'עץ'), row('d', 'סיר')];
    const session = [...board, row('замок', 'מנעול')];
    expect(boardMeanings(board, session, ['מנעול', 'שולחן', 'כיסא'], NONE)).toEqual(['טירה', 'דלי', 'עץ', 'סיר', 'שולחן']);
    expect(boardMeanings(board, session, ['מנעול', 'מנעול.', 'טירה'], NONE)).toBeNull();
  });

  it('stores each new type in its shape (spec D15)', () => {
    const ROW = CONTEXT[0];
    expect(generatedContent(ROW, 'listen_choice', { ...NOTHING_GENERATED, distractors: ['א', 'ב', 'ג'] }, NO_EXTRAS)).toMatchObject({
      prompt: null, alternatives: null, tiles: null,
    });
    expect(generatedContent(ROW, 'dictation', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: ROW.translation, options: null, alternatives: null, tiles: null, ...NO_SENTENCE,
    });
    expect(generatedContent(ROW, 'letter_tiles', NOTHING_GENERATED, { ...NO_EXTRAS, tiles: ['a', 'b', 'c', 'd', 'e'] })).toEqual({
      prompt: ROW.translation, options: null, alternatives: null, tiles: ['a', 'b', 'c', 'd', 'e'], ...NO_SENTENCE,
    });
    const board = generatedContent(ROW, 'matching', NOTHING_GENERATED, {
      ...NO_EXTRAS,
      board: { meanings: ['א', 'ב', 'ג', 'ד', 'ה'], own: 2 },
    });
    expect(board.options!.map((o) => o.is_correct)).toEqual([false, false, true, false, false]);
    expect(board.prompt).toBeNull();
  });

  // Phase 39 (spec D6). A new_meaning is generated as a multiple choice, and
  // services/sessions.ts maps it (generatedAs) before any of this sees it: a
  // caller that skipped the mapping fails here, rather than generating a card
  // that differs from the multiple choice it is.
  it('refuses a new_meaning: it is generated as a multiple choice', () => {
    expect(() => taskFor('new_meaning')).toThrow('generated as a multiple choice');
    expect(() => generatedContent(CONTEXT[0], 'new_meaning', { ...NOTHING_GENERATED, distractors: ['א', 'ב', 'ג'] }, NO_EXTRAS)).toThrow(
      'generated as a multiple choice',
    );
  });
});

// Review (final), Important 1: rows that ask the model nothing (a dictation, a
// tiles card, a board's later words) are still in the session.
describe('rows that ask the model nothing', () => {
  const castle = distractorItems(
    [{ glossId: 'g-s1', senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'замок', lemma: 'замок', partOfSpeech: 'noun', translation: 'טירה', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null }],
    ['meaning'],
    NO_RECENT,
  );
  const reply = (wrong: string[]) => ({ items: [{ key: 'q1', distractors: wrong }] });
  const LOCK = [{ form: 'замок', translation: 'מנעול' }];

  it("refuses another meaning of the item's word that a dictation holds (reproduction a)", () => {
    const verdict = validateDistractors(castle, reply(['מנעול', 'שולחן', 'כיסא']), 'he', LOCK, 'ru', NONE);
    expect(verdict.refused.size).toBeGreaterThan(0);
    expect(verdict.refused.get('q1')).toContain('another meaning of the same word');
    expect(validateDistractors(castle, reply(['מנעול', 'שולחן', 'כיסא']), 'he', [], 'ru', NONE).refused.size).toBe(0);
    expect(validateDistractors(castle, reply(['שולחן', 'כיסא', 'עט']), 'he', LOCK, 'ru', NONE).refused.size).toBe(0);
  });

  it('refuses, on a word item, the word of another row with the same meaning', () => {
    const word = distractorItems(
      [{ glossId: 'g-s1', senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null }],
      ['word'],
      NO_RECENT,
    );
    const verdict = validateDistractors(word, reply(['чеснок', 'морковь', 'репка']), 'he', [{ form: 'репка', translation: 'בצל' }], 'ru', NONE);
    expect(verdict.refused.size).toBeGreaterThan(0);
    expect(verdict.refused.get('q1')).toContain('same meaning');
  });

  describe('in the prompt', () => {
    const bare = buildDistractorPrompt({ items: castle, from: 'ru', to: 'he', others: [] });
    const LINE =
      'The words under also_in_session are asked elsewhere in the same session and need no answer, but the two rules above apply to them as if they were items.';

    it('lists a related row, and says what it is for, right after the shared-meaning rule', () => {
      const prompt = buildDistractorPrompt({ items: castle, from: 'ru', to: 'he', others: LOCK });
      const lines = prompt.system.split('\n');
      const rule = lines.findIndex((line) => line.startsWith('When several items share a meaning'));
      expect(lines[rule + 1]).toBe(LINE);
      expect(JSON.parse(prompt.user)).toEqual({
        ...JSON.parse(bare.user),
        also_in_session: [{ word: 'замок', correct: 'מנעול' }],
      });
      expect(prompt.system).toContain(DISTRACTOR_MARKER);
    });

    it('is byte-identical to the prompt without others when no row is related', () => {
      const unrelated = [{ form: 'стол', translation: 'שולחן' }];
      expect(buildDistractorPrompt({ items: castle, from: 'ru', to: 'he', others: unrelated })).toEqual(bare);
      expect(bare.system).not.toContain('also_in_session');
      expect(bare.user).not.toContain('also_in_session');
    });

    it('lists a row that shares only the meaning', () => {
      const prompt = buildDistractorPrompt({ items: castle, from: 'ru', to: 'he', others: [{ form: 'дворец', translation: 'טירה' }] });
      expect(JSON.parse(prompt.user).also_in_session).toEqual([{ word: 'дворец', correct: 'טירה' }]);
    });
  });
});

// Phase 54 (spec D7). A meet card asks the models nothing, and stores the Hebrew meaning as its prompt.
describe('the meet card generation', () => {
  const row = { glossId: 'g-s', senseId: 's', variantId: 'v', lexemeId: 'l', form: 'gatto', lemma: 'gatto', partOfSpeech: 'noun', translation: 'חתול', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null };
  it('asks the models nothing', () => {
    expect(taskFor('meet')).toBeNull();
  });
  it('stores the Hebrew as the prompt, as a read aloud does', () => {
    expect(generatedContent(row, 'meet', NOTHING_GENERATED, NO_EXTRAS)).toEqual(generatedContent(row, 'read_aloud', NOTHING_GENERATED, NO_EXTRAS));
    expect(generatedContent(row, 'meet', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: 'חתול',
      options: null,
      alternatives: null,
      tiles: null,
      ...NO_SENTENCE,
    });
  });
});

describe('phase 25 generation', () => {
  const row = { glossId: 'g-s', senseId: 's', variantId: 'v', lexemeId: 'l', form: 'gatto', lemma: 'gatto', partOfSpeech: 'noun', translation: 'חתול', example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null };
  it('asks the typed task for say the translation, and nothing for read aloud', () => {
    expect(taskFor('say_translation')).toBe('typed');
    expect(taskFor('read_aloud')).toBeNull();
  });
  it('stores the Hebrew as the prompt of both, and the alternatives of say the translation', () => {
    expect(generatedContent(row, 'read_aloud', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: 'חתול',
      options: null,
      alternatives: null,
      tiles: null,
      ...NO_SENTENCE,
    });
    expect(generatedContent(row, 'say_translation', { ...NOTHING_GENERATED, alternatives: ['micio'] }, NO_EXTRAS)).toEqual({
      prompt: 'חתול',
      options: null,
      alternatives: ['micio'],
      tiles: null,
      ...NO_SENTENCE,
    });
  });
});

describe('typed_meaning content (phase 27 D15)', () => {
  it('asks the model nothing and stores the meaning as the prompt', () => {
    const ROW = CONTEXT[0];
    expect(taskFor('typed_meaning')).toBeNull();
    expect(generatedContent(ROW, 'typed_meaning', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: ROW.translation,
      options: null,
      alternatives: null,
      tiles: null,
      ...NO_SENTENCE,
    });
  });
});

// Phase 27 Part B (spec D5 to D10): the three sentence tasks.
describe('the sentence tasks (phase 27 D5 to D10)', () => {
  const ROW: GenerationContext = {
    glossId: 'g-s1', senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'parlare', lemma: 'parlare', partOfSpeech: 'verb', translation: 'לדבר',
    example: 'Mi piace parlare con te.', exampleTranslation: 'אני אוהב לדבר איתך.',
    acceptedAnswers: [], answerForm: null, acceptedAt: null,
  };

  it('asks the three new types for gap, sentence and translate', () => {
    expect(taskFor('cloze_choice')).toBe('gap');
    expect(taskFor('cloze_typed')).toBe('sentence');
    expect(taskFor('sentence_translation')).toBe('translate');
  });

  describe('distractorItems', () => {
    const recent: RecentSentences = new Map([
      ['g-s1', { cloze: ['A uno.', 'B due.', 'C tre.', 'D quattro.'], translate: ['אחת', 'שתיים', 'שלוש', 'ארבע'] }],
    ]);
    it('avoids the saved example and the three newest recent sentences on a sentence item', () => {
      const [item] = distractorItems([ROW], ['sentence'], recent);
      expect(item.avoid).toEqual(['Mi piace parlare con te.', 'A uno.', 'B due.', 'C tre.']);
      expect(item).toMatchObject({ example: ROW.example, exampleTranslation: ROW.exampleTranslation });
    });
    it('avoids only the example when nothing is recent, and drops a missing example', () => {
      expect(distractorItems([ROW], ['sentence'], NO_RECENT)[0].avoid).toEqual(['Mi piace parlare con te.']);
      expect(distractorItems([{ ...ROW, example: null }], ['sentence'], NO_RECENT)[0].avoid).toEqual([]);
    });
    it('avoids on a gap item what a sentence item avoids: it writes its sentence too (phase 62 D1)', () => {
      expect(distractorItems([ROW], ['gap'], recent)[0].avoid).toEqual(['Mi piace parlare con te.', 'A uno.', 'B due.', 'C tre.']);
    });
    it('avoids the three newest recent translations on a translate item', () => {
      expect(distractorItems([{ ...ROW, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null }], ['translate'], recent)[0].avoid).toEqual(['אחת', 'שתיים', 'שלוש']);
    });
    it('also avoids the saved example\'s Hebrew on a translate item', () => {
      expect(distractorItems([ROW], ['translate'], recent)[0].avoid).toEqual(['אני אוהב לדבר איתך.', 'אחת', 'שתיים', 'שלוש']);
    });
    it('avoids nothing on any other item, and finds a gap item its blank', () => {
      expect(distractorItems([ROW], ['meaning'], recent)[0].avoid).toEqual([]);
      expect(distractorItems([ROW], ['gap'], recent)[0]).toMatchObject({ blank: 'parlare' });
      expect(distractorItems([ROW], ['word'], recent)[0].blank).toBeNull();
    });
  });

  describe('buildDistractorPrompt', () => {
    const items = [
      ...distractorItems([ROW], ['gap'], NO_RECENT),
      ...distractorItems([ROW], ['sentence'], NO_RECENT).map((item) => ({ ...item, key: 'q2' })),
      ...distractorItems([ROW], ['translate'], new Map([['g-s1', { cloze: [], translate: ['אחת'] }]])).map((item) => ({ ...item, key: 'q3' })),
    ];
    const prompt = buildDistractorPrompt({ items, from: 'it', to: 'he', others: [] });
    it('describes the three tasks and keeps the marker', () => {
      expect(prompt.system).toContain('- "gap":');
      expect(prompt.system).toContain('- "sentence":');
      expect(prompt.system).toContain('- "translate":');
      expect(prompt.system).toContain('4 to 8 words');
      expect(prompt.system).not.toContain('3 to 12 words');
      expect(prompt.system).toContain('3 to 5 words');
      expect(prompt.system).toContain(DISTRACTOR_MARKER);
    });
    it('asks a sentence for every word that fits its gap read alone, at most ten (phase 38 D2)', () => {
      expect(prompt.system).toContain('would fill the gap with the sentence read on its own, without its translation');
      expect(prompt.system).toContain('at most 10');
      expect(prompt.system).toContain('whatever it then means, not only words of the same meaning');
      expect(prompt.system).toContain('agreeing in gender, number and case with the words around it');
    });
    it('sends the learner\'s practised words once, and asks the translation to use them (phase 59 D1)', () => {
      const learnerWords = [
        { key: 'w1', glossId: 'g-a', word: 'amico', meaning: 'חבר' },
        { key: 'w2', glossId: 'g-b', word: 'andare', meaning: 'ללכת' },
      ];
      const withWords = buildDistractorPrompt({ items, from: 'it', to: 'he', others: [], learnerWords });
      const sent = JSON.parse(withWords.user) as { learner_words?: unknown };
      expect(sent.learner_words).toEqual([
        { key: 'w1', word: 'amico', meaning: 'חבר' },
        { key: 'w2', word: 'andare', meaning: 'ללכת' },
      ]);
      expect(withWords.system).toContain('learner_words');
    });
    it('sends the learner\'s words with a gap or sentence item alone, and asks those sentences to use them (phase 62 D1)', () => {
      const learnerWords = [{ key: 'w1', glossId: 'g-a', word: 'amico', meaning: 'חבר' }];
      for (const task of ['gap', 'sentence'] as const) {
        const alone = buildDistractorPrompt({ items: distractorItems([ROW], [task], NO_RECENT), from: 'it', to: 'he', others: [], learnerWords });
        expect((JSON.parse(alone.user) as { learner_words?: unknown }).learner_words).toEqual([{ key: 'w1', word: 'amico', meaning: 'חבר' }]);
      }
      const sentenceRule = prompt.system.split('\n').find((line) => line.startsWith('- "sentence":'))!;
      expect(sentenceRule).toContain('learner_words');
      // R5: pointing to the word comes before the learner's words.
      expect(sentenceRule.indexOf('point to the word')).toBeLessThan(sentenceRule.indexOf('learner_words'));
    });
    it('asks a gap item for its own new sentence, as a sentence item writes, and wrong words for its gap (phase 62 D1)', () => {
      const gapRule = prompt.system.split('\n').find((line) => line.startsWith('- "gap":'))!;
      expect(gapRule).toContain('as a "sentence" item');
      expect(gapRule).toContain(DISTRACTOR_MARKER);
    });
    it('sends no learner words when no item translates (phase 59 D1)', () => {
      const plain = distractorItems([ROW], ['meaning'], NO_RECENT);
      const learnerWords = [{ key: 'w1', glossId: 'g-a', word: 'amico', meaning: 'חבר' }];
      const sent = JSON.parse(buildDistractorPrompt({ items: plain, from: 'it', to: 'he', others: [], learnerWords }).user) as Record<string, unknown>;
      expect(sent).not.toHaveProperty('learner_words');
    });
    it('asks for a sentence whose other words point to its word (phase 41 D1)', () => {
      expect(prompt.system).toContain('its other words point to the word');
      expect(prompt.system).toContain('Please ___ the file.');
    });
    it('sends the example, its translation and the sentences to avoid', () => {
      const sent = JSON.parse(prompt.user) as { items: Record<string, unknown>[] };
      expect(sent.items[0]).toMatchObject({
        key: 'q1', task: 'gap', example: ROW.example, example_translation: ROW.exampleTranslation, avoid: ['Mi piace parlare con te.'],
      });
      // Phase 62 (spec D1): a gap item writes its own sentence, so it is sent no blanked one.
      expect(sent.items[0]).not.toHaveProperty('sentence');
      expect(sent.items[0]).not.toHaveProperty('blank');
      expect(sent.items[1]).toMatchObject({ task: 'sentence', avoid: ['Mi piace parlare con te.'] });
      expect(sent.items[2]).toMatchObject({ task: 'translate', avoid: [ROW.exampleTranslation, 'אחת'] });
    });
    it('sends the example keys on the sentence tasks only, as before Part B for the others', () => {
      const old = distractorItems([ROW], ['meaning'], NO_RECENT).concat(
        distractorItems([ROW], ['word'], NO_RECENT).map((item) => ({ ...item, key: 'q2' })),
        distractorItems([ROW], ['typed'], NO_RECENT).map((item) => ({ ...item, key: 'q3' })),
      );
      const sent = JSON.parse(buildDistractorPrompt({ items: old, from: 'it', to: 'he', others: [] }).user) as { items: Record<string, unknown>[] };
      for (const item of sent.items) {
        expect(item).not.toHaveProperty('example');
        expect(item).not.toHaveProperty('example_translation');
        expect(item).not.toHaveProperty('blank');
        expect(item).not.toHaveProperty('avoid');
      }
    });
  });

  describe('validateDistractors', () => {
    const gapItem = distractorItems([ROW], ['gap'], NO_RECENT);
    // Phase 62 (spec D1): a gap item writes its own sentence, and wrong words for its gap.
    const written = { sentence: 'Voglio parlare con lei.', gap: 'parlare', translation: 'אני רוצה לדבר איתה.' };
    const gapReply = (wrong: string[], sentence: Record<string, string> = written) => ({ items: [{ key: 'q1', distractors: wrong, ...sentence }] });
    it('takes a gap item as its sentence and three wrong target words', () => {
      const verdict = validateDistractors(gapItem, gapReply(['parlai', 'parlato', 'parlò']), 'he', [], 'it', NONE);
      expect(verdict.byKey.get('q1')).toEqual({
        distractors: ['parlai', 'parlato', 'parlò'], spares: [], alternatives: [], translate: null, degraded: null,
        sentence: { sentence: 'Voglio parlare con lei.', translation: 'אני רוצה לדבר איתה.', gap: { start: 7, end: 14 }, alternatives: [] },
      });
    });
    it('refuses a gap item whose sentence is unusable, with the reason (ruling R7)', () => {
      const verdict = validateDistractors(gapItem, gapReply(['parlai', 'parlato', 'parlò'], { ...written, sentence: 'Oggi voglio parlare a lungo con mia madre e Tom.' }), 'he', [], 'it', NONE);
      expect(verdict.byKey.has('q1')).toBe(false);
      expect(verdict.refused.get('q1')).toBe('the sentence has 10 words');
    });
    it('drops a wrong word that is the generated gap\'s own text', () => {
      const inflected = { sentence: 'Ieri parlavamo per ore.', gap: 'parlavamo', translation: 'אתמול דיברנו שעות.' };
      const verdict = validateDistractors(gapItem, gapReply(['parlai', 'parlavamo', 'parlò', 'parlasti'], inflected), 'he', [], 'it', NONE);
      expect(verdict.byKey.get('q1')?.distractors).toEqual(['parlai', 'parlò', 'parlasti']);
    });
    it('refuses a gap item that offers the form, the lemma, a Hebrew word or too few', () => {
      expect(validateDistractors(gapItem, gapReply(['parlai', 'Parlare', 'parlò']), 'he', [], 'it', NONE).refused.size).toBeGreaterThan(0);
      expect(validateDistractors(gapItem, gapReply(['parlai', 'דיבר', 'parlò']), 'he', [], 'it', NONE).refused.size).toBeGreaterThan(0);
      expect(validateDistractors(gapItem, gapReply(['parlai', 'parlò']), 'he', [], 'it', NONE).refused.size).toBeGreaterThan(0);
    });
    it('refuses a gap item that offers its own form when the example blanks another one', () => {
      const inflected = distractorItems([{ ...ROW, form: 'parlavamo', lemma: 'parlare', example: 'Ieri parlavamo per ore.' }], ['gap'], NO_RECENT);
      expect(validateDistractors(inflected, gapReply(['parlai', 'parlavamo', 'parlò']), 'he', [], 'it', NONE).refused.size).toBeGreaterThan(0);
    });
    it('refuses a gap item that offers the lemma when the blank is an inflected form', () => {
      const inflected = distractorItems([{ ...ROW, form: 'parlavamo', lemma: 'parlare', example: 'Ieri parlavamo per ore.' }], ['gap'], NO_RECENT);
      expect(validateDistractors(inflected, gapReply(['parlai', 'parlare', 'parlò']), 'he', [], 'it', NONE).refused.size).toBeGreaterThan(0);
    });

    const SENTENCE = distractorItems([ROW], ['sentence'], NO_RECENT);
    const TRANSLATE = distractorItems([ROW], ['translate'], NO_RECENT);
    it('keeps the validated content of a sentence item', () => {
      const verdict = validateDistractors(SENTENCE, {
        items: [{ key: 'q1', distractors: [], sentence: 'Ieri parlavamo per ore.', gap: 'parlavamo', translation: 'אתמול דיברנו שעות.' }],
      }, 'he', [], 'it', NONE);
      expect(verdict.byKey.get('q1')).toEqual({
        distractors: [], spares: [], alternatives: [], degraded: null, translate: null,
        sentence: { sentence: 'Ieri parlavamo per ore.', translation: 'אתמול דיברנו שעות.', gap: { start: 5, end: 14 }, alternatives: [] },
      });
    });
    it('never refuses for a sentence or translate item: it degrades with the reason', () => {
      const verdict = validateDistractors([...SENTENCE, ...TRANSLATE.map((item) => ({ ...item, key: 'q2' }))], {
        items: [{ key: 'q1', distractors: [] }, { key: 'q2', distractors: [], sentence: 'אנא', translation: 'x', gap: 'y' }],
      }, 'he', [], 'it', NONE);
      expect(verdict.refused.size).toBe(0);
      const byKey = verdict.byKey;
      expect(byKey.get('q1')).toMatchObject({ sentence: null, translate: null, degraded: expect.any(String) });
      expect(byKey.get('q2')).toMatchObject({ sentence: null, translate: null, degraded: expect.any(String) });
    });
    it('keeps the validated content of a translate item', () => {
      const verdict = validateDistractors(TRANSLATE, {
        items: [{ key: 'q1', distractors: [], sentence: 'דיברנו שעות רבות', translation: 'Abbiamo parlato per ore.', gap: 'parlato' }],
      }, 'he', [], 'it', NONE);
      expect(verdict.byKey.get('q1')).toMatchObject({
        sentence: null, degraded: null,
        translate: { hebrew: 'דיברנו שעות רבות', reference: 'Abbiamo parlato per ore.', gap: { start: 8, end: 15 } },
      });
    });
    it('degrades an item the model did not answer at all, but still refuses a choice item', () => {
      const none = validateDistractors(SENTENCE, { items: [] }, 'he', [], 'it', NONE);
      expect(none.byKey.get('q1')?.degraded).toEqual(expect.any(String));
      expect(validateDistractors(gapItem, { items: [] }, 'he', [], 'it', NONE).refused.size).toBeGreaterThan(0);
    });
  });

  describe('generatedContent', () => {
    const nothing = { prompt: null, options: null, alternatives: null, tiles: null, ...NO_SENTENCE };
    const extras = { ...NO_EXTRAS, gap: { start: 9, end: 16 } };
    // Phase 62 (spec D1): a cloze choice's sentence is written for the session, as a typed cloze's is.
    const written = { sentence: 'Ieri parlavamo per ore.', translation: 'אתמול דיברנו שעות.', gap: { start: 5, end: 14 }, alternatives: [] };
    it('stores a cloze choice from its generated sentence, the gap text correct first', () => {
      const content = generatedContent(ROW, 'cloze_choice', { ...NOTHING_GENERATED, sentence: written, distractors: ['parlai', 'parlato', 'parlò'] }, NO_EXTRAS);
      expect(content).toEqual({
        ...nothing,
        prompt: 'לדבר',
        options: optionsFor('parlavamo', ['parlai', 'parlato', 'parlò']),
        sentence: 'Ieri parlavamo per ore.',
        sentenceTranslation: 'אתמול דיברנו שעות.',
        gapStart: 5,
        gapEnd: 14,
      });
    });
    it('gives the wrong words the capital of the blank, so the right one is no tell', () => {
      const opening = { sentence: 'Parlare è bello.', translation: 'לדבר זה יפה.', gap: { start: 0, end: 7 }, alternatives: [] };
      const upper = generatedContent(ROW, 'cloze_choice', { ...NOTHING_GENERATED, sentence: opening, distractors: ['parlai', 'Parlato', 'parlò'] }, NO_EXTRAS);
      expect(upper.options!.map((o) => o.text)).toEqual(['Parlare', 'Parlai', 'Parlato', 'Parlò']);
      const lower = generatedContent(ROW, 'cloze_choice', { ...NOTHING_GENERATED, sentence: written, distractors: ['Parlai', 'parlato', 'Parlò'] }, NO_EXTRAS);
      expect(lower.options!.map((o) => o.text)).toEqual(['parlavamo', 'parlai', 'parlato', 'parlò']);
    });
    it('stores a cloze typed card from its generated sentence', () => {
      const sentence = { sentence: 'Ieri parlavamo per ore.', translation: 'אתמול דיברנו שעות.', gap: { start: 5, end: 14 }, alternatives: ['chiacchieravamo'] };
      expect(generatedContent(ROW, 'cloze_typed', { ...NOTHING_GENERATED, sentence }, NO_EXTRAS)).toEqual({
        ...nothing,
        prompt: 'לדבר',
        alternatives: ['chiacchieravamo'],
        sentence: 'Ieri parlavamo per ore.',
        sentenceTranslation: 'אתמול דיברנו שעות.',
        gapStart: 5,
        gapEnd: 14,
      });
    });
    it('stores a sentence translation with the reference as its sentence', () => {
      const translate = { hebrew: 'דיברנו שעות רבות', reference: 'Abbiamo parlato per ore.', gap: { start: 8, end: 15 } };
      expect(generatedContent(ROW, 'sentence_translation', { ...NOTHING_GENERATED, translate }, NO_EXTRAS)).toEqual({
        ...nothing,
        prompt: 'לדבר',
        sentence: 'Abbiamo parlato per ore.',
        sentenceTranslation: 'דיברנו שעות רבות',
        gapStart: 8,
        gapEnd: 15,
      });
    });
    it('throws when the content or the gap is missing', () => {
      expect(() => generatedContent(ROW, 'cloze_typed', NOTHING_GENERATED, NO_EXTRAS)).toThrow();
      expect(() => generatedContent(ROW, 'sentence_translation', NOTHING_GENERATED, NO_EXTRAS)).toThrow();
      expect(() => generatedContent(ROW, 'cloze_choice', NOTHING_GENERATED, NO_EXTRAS)).toThrow();
      expect(() => generatedContent({ ...ROW, example: null }, 'cloze_choice', NOTHING_GENERATED, extras)).toThrow();
    });
  });
});

describe('withSiblingAlternatives (spec D18)', () => {
  it('accepts the sibling headwords first, never the card’s own word, then the model’s alternatives', () => {
    expect(
      withSiblingAlternatives({
        form: 'booked',
        lemma: 'book',
        siblings: ['order', 'reserve', 'book'],
        alternatives: ['reserved', 'Order', 'arranged', 'scheduled', 'set up'],
      }),
    ).toEqual(['order', 'reserve', 'reserved', 'arranged', 'scheduled', 'set up']);
  });

  it('keeps three siblings first, then the model’s alternatives, then the other siblings, up to ten', () => {
    expect(
      withSiblingAlternatives({
        form: 'booked',
        lemma: 'book',
        siblings: ['arrange', 'charter', 'hire', 'order', 'reserve', 'schedule'],
        alternatives: ['reserved', 'ordered'],
      }),
    ).toEqual(['arrange', 'charter', 'hire', 'reserved', 'ordered', 'order', 'reserve', 'schedule']);
    expect(
      withSiblingAlternatives({
        form: 'booked',
        lemma: 'book',
        siblings: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
        alternatives: ['reserved', 'ordered', 'hired', 'chartered', 'scheduled'],
      }),
    ).toEqual(['a1', 'a2', 'a3', 'reserved', 'ordered', 'hired', 'chartered', 'scheduled', 'a4', 'a5']);
  });

  it('lets more siblings in after the model’s alternatives when the model gave few', () => {
    expect(
      withSiblingAlternatives({
        form: 'booked',
        lemma: 'book',
        siblings: ['arrange', 'charter', 'hire', 'order', 'reserve'],
        alternatives: ['reserved'],
      }),
    ).toEqual(['arrange', 'charter', 'hire', 'reserved', 'order', 'reserve']);
    expect(
      withSiblingAlternatives({ form: 'booked', lemma: 'book', siblings: ['arrange', 'charter', 'hire', 'order', 'reserve'], alternatives: [] }),
    ).toEqual(['arrange', 'charter', 'hire', 'order', 'reserve']);
  });

  it('counts only kept siblings among the first three: the card’s own lemma or a repeat takes no slot', () => {
    expect(
      withSiblingAlternatives({
        form: 'booked',
        lemma: 'book',
        siblings: ['Book', 'arrange', 'Arrange', 'charter', 'hire', 'order'],
        alternatives: ['reserved', 'ordered', 'set up'],
      }),
    ).toEqual(['arrange', 'charter', 'hire', 'reserved', 'ordered', 'set up', 'order']);
  });

  // Phase 34 (spec D1). The rendering's stored list is the certain part, and
  // comes before everything a session's model wrote.
  describe('with the rendering’s stored accepted answers', () => {
    it('puts the stored list first, then three siblings, then the session’s alternatives, deduped', () => {
      expect(
        withSiblingAlternatives({
          form: 'booked',
          lemma: 'book',
          accepted: ['reserved', 'ordered'],
          siblings: ['arrange', 'charter', 'hire', 'order'],
          alternatives: ['Reserved', 'hired', 'set up'],
        }),
      ).toEqual(['reserved', 'ordered', 'arrange', 'charter', 'hire', 'hired', 'set up', 'order']);
    });

    it('never drops a stored answer for what a session wrote when the cap is hit', () => {
      const accepted = Array.from({ length: 10 }, (_, i) => `stored${i}`);
      const kept = withSiblingAlternatives({
        form: 'booked',
        lemma: 'book',
        accepted,
        siblings: ['order'],
        alternatives: ['reserved', 'ordered'],
      });
      expect(kept).toEqual(accepted);
      expect(kept).toHaveLength(MAX_CARD_ALTERNATIVES);
    });

    it('keeps the card’s own form and lemma out of the stored list, as out of the rest', () => {
      expect(
        withSiblingAlternatives({ form: 'ore', lemma: 'ora', accepted: ['ore', 'Ora', 'molte ore'], siblings: [], alternatives: [] }),
      ).toEqual(['molte ore']);
    });

    it('with no stored list is what it was before phase 34', () => {
      const input = { form: 'booked', lemma: 'book', siblings: ['order', 'reserve'], alternatives: ['reserved'] };
      expect(withSiblingAlternatives({ ...input, accepted: [] })).toEqual(withSiblingAlternatives(input));
    });
  });
});

// Phase 34 (spec D2, D12). A card whose rendering has an answer form asks for it:
// the typed and spoken answer, the tiles, and the choice cards' shown form. The
// answer form is stored on the question, so a later change alters no asked card.
describe('the answer form (phase 34, spec D2, D12)', () => {
  // The audit's card 2260df83: ora, saved from its plural rendering שעות.
  const ORA: GenerationContext = {
    glossId: 'g-hours', senseId: 's-hours', variantId: 'v-ora', lexemeId: 'l-ora', form: 'ora', lemma: 'ora', partOfSpeech: 'noun',
    translation: 'שעות', example: 'Ho aspettato per ore.', exampleTranslation: 'חיכיתי שעות.',
    acceptedAnswers: ['ore'], answerForm: 'ore', acceptedAt: new Date('2026-10-11T10:00:00Z'),
  };
  const generated = { ...NOTHING_GENERATED, distractors: ['a', 'b', 'c'], alternatives: ['x'] };

  it('stores the answer form on each of the six cards that ask for it', () => {
    for (const type of ['multiple_choice', 'listen_choice', 'reverse_choice', 'typed_translation', 'say_translation'] as const) {
      expect(generatedContent(ORA, type, generated, NO_EXTRAS).answerForm).toBe('ore');
    }
    expect(generatedContent(ORA, 'letter_tiles', generated, { ...NO_EXTRAS, tiles: ['o', 'r', 'e', 'x', 'z'] }).answerForm).toBe('ore');
  });

  it('puts the answer form, not the saved form, among a reversed card’s options, and leaves a choice’s meaning alone', () => {
    expect(generatedContent(ORA, 'reverse_choice', generated, NO_EXTRAS).options).toEqual(optionsFor('ore', ['a', 'b', 'c']));
    expect(generatedContent(ORA, 'multiple_choice', generated, NO_EXTRAS).options).toEqual(optionsFor('שעות', ['a', 'b', 'c']));
  });

  it('stores nothing for a card with no answer form, as before', () => {
    const plain = { ...ORA, answerForm: null };
    expect(generatedContent(plain, 'typed_translation', generated, NO_EXTRAS).answerForm).toBeNull();
    expect(generatedContent(plain, 'reverse_choice', generated, NO_EXTRAS).options).toEqual(optionsFor('ora', ['a', 'b', 'c']));
  });

  it('stores it on no other card: a dictation, a read-aloud, a meaning card, a board word or a sentence card', () => {
    const sentence = { sentence: 'Ieri ho aspettato per ore.', translation: 'אתמול חיכיתי שעות.', gap: { start: 14, end: 22 }, alternatives: [] };
    const translate = { hebrew: 'חיכיתי שעות', reference: 'Ho aspettato per ore.', gap: { start: 3, end: 12 } };
    for (const type of ['dictation', 'read_aloud', 'meet', 'typed_meaning'] as const) {
      expect(generatedContent(ORA, type, generated, NO_EXTRAS).answerForm).toBeNull();
    }
    expect(generatedContent(ORA, 'matching', generated, { ...NO_EXTRAS, board: { meanings: ['שעות', 'a', 'b', 'c', 'd'], own: 0 } }).answerForm).toBeNull();
    expect(generatedContent(ORA, 'cloze_choice', { ...generated, sentence }, NO_EXTRAS).answerForm).toBeNull();
    expect(generatedContent(ORA, 'cloze_typed', { ...NOTHING_GENERATED, sentence }, NO_EXTRAS).answerForm).toBeNull();
    expect(generatedContent(ORA, 'sentence_translation', { ...NOTHING_GENERATED, translate }, NO_EXTRAS).answerForm).toBeNull();
  });

  it('carries the answer form into the item, so a wrong word is never the card’s own answer', () => {
    const [item] = distractorItems([ORA], ['word'], NO_RECENT);
    expect(item.answerForm).toBe('ore');
    // The model sees the saved form and writes `ore` among the wrong words of a card whose right option is `ore`.
    const verdict = validateDistractors([item], { items: [{ key: 'q1', distractors: ['tempo', 'ore', 'giorno'] }] }, 'he', [], 'it', NONE);
    expect(verdict.refused.size).toBeGreaterThan(0);
    const fine = validateDistractors([item], { items: [{ key: 'q1', distractors: ['tempo', 'minuto', 'giorno'] }] }, 'he', [], 'it', NONE);
    expect(fine.refused.size).toBe(0);
  });
});

// Phase 34 (spec D3, D4). A wrong option is never one the dictionary already
// knows to be right, and a choice item asks for six to keep three. The audit's
// cards, rebuilt: c49ddbec, 0fa3fc06, the saw homograph (a7d6bdb4), 1d268882.
describe('phase 34: the known-right set and the spares (spec D3, D4)', () => {
  const english = (over: Partial<GenerationContext> & Pick<GenerationContext, 'form' | 'lemma' | 'translation' | 'lexemeId'>): GenerationContext => ({
    glossId: `g-${over.lexemeId}`, senseId: `s-${over.lexemeId}`, variantId: `v-${over.lexemeId}`, partOfSpeech: 'verb',
    example: null, exampleTranslation: null, acceptedAnswers: [], answerForm: null, acceptedAt: null, ...over,
  });
  const known = (over: Partial<KnownRight>): KnownRight => ({ ...nothingKnown(), ...over });
  const one = (key: string, distractors: string[]) => ({ items: [{ key, distractors }] });
  const kept = (verdict: ReturnType<typeof validateDistractors>, key = 'q1') => verdict.byKey.get(key);

  // c49ddbec: `pick up`, stored as לענות (the phone), offered להרים, its own other sense.
  const PICK_UP = english({ lexemeId: 'l-pick-up', form: 'pick up', lemma: 'pick up', translation: 'לענות' });
  const pickUpItems = distractorItems([PICK_UP], ['meaning'], NO_RECENT);
  const PICK_UP_KNOWN = known({ meaningsByLexeme: new Map([['l-pick-up', ['לענות', 'להרים', 'לאסוף']]]) });

  it('category A (c49ddbec): refuses להרים on the card for pick up, and a spare takes its place', () => {
    const offered = ['להרים', 'לכתוב', 'לשיר', 'לרקוד', 'לבשל', 'לישון'];
    expect(kept(validateDistractors(pickUpItems, one('q1', offered), 'he', [], 'en', PICK_UP_KNOWN))).toEqual({
      ...NOTHING_GENERATED,
      distractors: ['לכתוב', 'לשיר', 'לרקוד'],
      spares: ['לבשל', 'לישון'],
    });
    // Without the dictionary's other sense, להרים would be shown: the set is what refuses it.
    expect(kept(validateDistractors(pickUpItems, one('q1', offered), 'he', [], 'en', NONE))).toMatchObject({ distractors: ['להרים', 'לכתוב', 'לשיר'] });
  });

  it('category A (the saw homograph, a7d6bdb4’s word): refuses ראה on a card for saw, the meaning of its homograph see', () => {
    const saw = distractorItems([english({ lexemeId: 'l-saw', form: 'saw', lemma: 'saw', translation: 'לנסר' })], ['meaning'], NO_RECENT);
    // The read lists see's meanings under saw's lexeme: see has a variant spelled saw.
    const homograph = known({ meaningsByLexeme: new Map([['l-saw', ['לנסר', 'מסור', 'ראה', 'לראות']]]) });
    const verdict = validateDistractors(saw, one('q1', ['ראה', 'לשייף', 'לקדוח', 'לשבור', 'לצבוע']), 'he', [], 'en', homograph);
    expect(kept(verdict)).toMatchObject({ distractors: ['לשייף', 'לקדוח', 'לשבור'], spares: ['לצבוע'] });
    // Under comparable: pointed, or with a full stop, it is the same word.
    expect(kept(validateDistractors(saw, one('q1', ['רָאָה.', 'לשייף', 'לקדוח', 'לשבור']), 'he', [], 'en', homograph))).toMatchObject({
      distractors: ['לשייף', 'לקדוח', 'לשבור'],
    });
  });

  it('category A (0fa3fc06): refuses presto on the reversed card for תכף, an answer the accept job stored for that Hebrew', () => {
    const tekhef = distractorItems(
      [english({ lexemeId: 'l-ora', form: 'ora', lemma: 'ora', partOfSpeech: 'adverb', translation: 'תכף' })],
      ['word'],
      NO_RECENT,
    );
    // Keyed by the rendering's own text, pointed here: the rule compares under comparable.
    const accepted = known({ wordsByPrompt: new Map([['תֵּכֶף', ['presto', 'subito', 'ora']]]) });
    const offered = ['presto', 'sempre', 'mai', 'ieri', 'lontano', 'spesso'];
    expect(kept(validateDistractors(tekhef, one('q1', offered), 'he', [], 'it', accepted))).toMatchObject({
      distractors: ['sempre', 'mai', 'ieri'],
      spares: ['lontano', 'spesso'],
    });
    expect(kept(validateDistractors(tekhef, one('q1', offered), 'he', [], 'it', NONE))).toMatchObject({ distractors: ['presto', 'sempre', 'mai'] });
  });

  it('keeps the first three usable of six when two are refused, and fails only under three', () => {
    // Two refused: the answer itself and a known meaning.
    const two = ['לענות', 'לכתוב', 'להרים', 'לשיר', 'לרקוד', 'לבשל'];
    expect(kept(validateDistractors(pickUpItems, one('q1', two), 'he', [], 'en', PICK_UP_KNOWN))).toMatchObject({
      distractors: ['לכתוב', 'לשיר', 'לרקוד'],
      spares: ['לבשל'],
    });
    // Four refused: two known meanings, the answer, and a repeat. Two usable is a failed batch.
    const four = ['להרים', 'לאסוף', 'לענות', 'לכתוב', 'לכתוב.', 'לשיר'];
    const failed = validateDistractors(pickUpItems, one('q1', four), 'he', [], 'en', PICK_UP_KNOWN);
    expect(failed.byKey.has('q1')).toBe(false);
    expect(failed.refused.get('q1')).toBe('q1 offers להרים, which the dictionary knows is a meaning of pick up (2 of 6 usable, 3 needed)');
    // Exactly three usable is enough, with no spare.
    const three = ['להרים', 'לאסוף', 'לענות', 'לכתוב', 'לשיר', 'לרקוד'];
    expect(kept(validateDistractors(pickUpItems, one('q1', three), 'he', [], 'en', PICK_UP_KNOWN))).toMatchObject({
      distractors: ['לכתוב', 'לשיר', 'לרקוד'],
      spares: [],
    });
  });

  // Review, fix round 1: the checker numbers what it is asked, and a miscount
  // leaves that card unjudged and refused (phase 48, spec D2, ruling R3), so it is
  // never asked more than the six the prompt asks for.
  it('keeps at most six usable wrong options, three shown and three spares, whatever the model returns', () => {
    const eight = ['לכתוב', 'לשיר', 'לרקוד', 'לבשל', 'לישון', 'לקרוא', 'לצייר', 'לשחות'];
    // Past the parser, which already refuses a seventh (LlmDistractorsSchema).
    expect(kept(validateDistractors(pickUpItems, one('q1', eight), 'he', [], 'en', NONE))).toEqual({
      ...NOTHING_GENERATED,
      distractors: ['לכתוב', 'לשיר', 'לרקוד'],
      spares: ['לבשל', 'לישון', 'לקרוא'],
    });
    expect(ASKED_DISTRACTORS).toBe(6);
  });

  it('asks for six wrong answers, best first', () => {
    const prompt = buildDistractorPrompt({ items: pickUpItems, from: 'en', to: 'he', others: [] });
    expect(DISTRACTOR_MARKER).toBe('six wrong answers');
    expect(prompt.system).toContain('Write six wrong answers in Hebrew as distractors');
    expect(prompt.system).toContain('Put the best first');
  });

  it('category A (1d268882): never takes poi’s own אחר כך as the fifth meaning of a board where poi means אז', () => {
    const row = (lexemeId: string, form: string, translation: string) => english({ lexemeId, form, lemma: form, translation });
    const board = [row('l-poi', 'poi', 'אז'), row('l-casa', 'casa', 'בית'), row('l-cane', 'cane', 'כלב'), row('l-mare', 'mare', 'ים')];
    const poi = known({ meaningsByLexeme: new Map([['l-poi', ['אז', 'אחר כך', 'לאחר מכן']]]) });
    expect(boardMeanings(board, board, ['אחר כך', 'לאחר מכן', 'מחר'], poi)).toEqual(['אז', 'בית', 'כלב', 'ים', 'מחר']);
    expect(boardMeanings(board, board, ['אחר כך', 'לאחר מכן'], poi)).toBeNull();
    // A known meaning of any of the four, not only the first word's.
    const sea = known({ meaningsByLexeme: new Map([['l-mare', ['ים', 'אוקיינוס']]]) });
    expect(boardMeanings(board, board, ['אוקיינוס', 'מחר'], sea)).toEqual(['אז', 'בית', 'כלב', 'ים', 'מחר']);
    expect(boardMeanings(board, board, ['אחר כך', 'מחר'], NONE)).toEqual(['אז', 'בית', 'כלב', 'ים', 'אחר כך']);
  });

  it('reads the known words for a prompt under comparable, and none for another prompt', () => {
    const words = known({ wordsByPrompt: new Map([['תֵּכֶף.', ['presto']], ['תכף', ['subito']], ['מיד', ['subito', 'immediatamente']]]) });
    expect(knownWords(words, 'תכף')).toEqual(['presto', 'subito']);
    expect(knownWords(words, 'עכשיו')).toEqual([]);
  });
});

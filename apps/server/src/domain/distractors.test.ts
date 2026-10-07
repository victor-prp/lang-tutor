import { describe, expect, it } from '@jest/globals';

import type { QuestionType } from '@lang-tutor/core/domain';

import {
  DISTRACTOR_MARKER,
  MAX_ALTERNATIVES,
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
  type GenerationContext,
  type RecentSentences,
} from './distractors';
import { planSession } from './plan';

const NO_RECENT: RecentSentences = new Map();
const NO_SENTENCE = { sentence: null, sentenceTranslation: null, gapStart: null, gapEnd: null };

/** Items for today's card only, as every batch was before phase 23. */
const meaningItems = (context: GenerationContext[]) =>
  distractorItems(context, context.map((): QuestionType => 'multiple_choice').map(taskFor), NO_RECENT);

const CONTEXT: GenerationContext[] = [
  { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה', example: null, exampleTranslation: null },
  { senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null },
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
    expect(parseLlmDistractors(JSON.stringify({ items: [{ key: 'q1', distractors: ['a', 'b', 'c', 'd'] }] }))).toBeNull();
    expect(parseLlmDistractors(JSON.stringify({ items: [{ distractors: [] }] }))).toBeNull();
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

describe('validateDistractors', () => {
  const answer = (q1: string[], q2: string[] = ['קשת', 'שום', 'גזר']) => ({
    items: [
      { key: 'q1', distractors: q1 },
      { key: 'q2', distractors: q2 },
    ],
  });

  it('accepts three distinct wrong answers per item, trimmed', () => {
    const verdict = validateDistractors(ITEMS, answer([' כתבה', 'שמעה', 'ראתה ']), 'he', [], 'ru');
    expect(verdict).toEqual({
      ok: true,
      byKey: new Map([
        ['q1', { ...NOTHING_GENERATED, distractors: ['כתבה', 'שמעה', 'ראתה'] }],
        ['q2', { ...NOTHING_GENERATED, distractors: ['קשת', 'שום', 'גזר'] }],
      ]),
    });
  });

  it('ignores keys nobody asked for', () => {
    const verdict = validateDistractors(ITEMS, {
      items: [...answer(['כתבה', 'שמעה', 'ראתה']).items, { key: 'q9', distractors: ['x', 'y', 'z'] }],
    }, 'he', [], 'ru');
    expect(verdict.ok).toBe(true);
  });

  it('refuses an item with no answer', () => {
    const verdict = validateDistractors(ITEMS, { items: [{ key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] }] }, 'he', [], 'ru');
    expect(verdict).toEqual({ ok: false, reason: 'no answer for q2' });
  });

  it('refuses fewer than three wrong answers on a choice item', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', 'שמעה']), 'he', [], 'ru').ok).toBe(false);
  });

  it('refuses an empty distractor', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', '  ', 'ראתה']), 'he', [], 'ru').ok).toBe(false);
  });

  // Review Focus 4: the right answer in disguise.
  it.each([['קראה'], ['קראה '], ['קראה.']])('refuses the correct answer as a distractor: %j', (disguised) => {
    expect(validateDistractors(ITEMS, answer(['כתבה', disguised, 'ראתה']), 'he', [], 'ru').ok).toBe(false);
  });

  it('refuses two equal distractors', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', 'כתבה', 'ראתה']), 'he', [], 'ru').ok).toBe(false);
  });

  // The comparison is the validator's own: a multi-word answer keeps its mark
  // in a dictionary key, but here "the same option" ignores it, and nikud.
  describe('multi-word answers and pointed copies', () => {
    const phrase = meaningItems([
      { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'большое спасибо', lemma: 'спасибо', partOfSpeech: 'phrase', translation: 'תודה רבה', example: null, exampleTranslation: null },
    ]);
    const one = (distractors: string[]) => ({ items: [{ key: 'q1', distractors }] });

    it.each([['תודה רבה.'], ['תודה רבה!'], ['תודה  רבה'], ['תודה רבה…'], ['תודה רבה?!']])(
      'refuses the multi-word answer in disguise: %j',
      (disguised) => {
        expect(validateDistractors(phrase, one(['כתבה', disguised, 'ראתה']), 'he', [], 'ru').ok).toBe(false);
      },
    );

    it('accepts a different multi-word option', () => {
      expect(validateDistractors(phrase, one(['בבקשה רבה', 'להתראות', 'ערב טוב']), 'he', [], 'ru').ok).toBe(true);
    });

    it('refuses a pointed copy of the answer', () => {
      expect(validateDistractors(ITEMS, answer(['כתבה', 'קָרָאָה', 'ראתה']), 'he', [], 'ru').ok).toBe(false);
    });

    it('counts two distractors that differ only in points, marks or spacing as equal', () => {
      expect(validateDistractors(phrase, one(['כתבה', 'כָּתְבָה', 'כתבה.']), 'he', [], 'ru').ok).toBe(false);
      expect(validateDistractors(phrase, one(['שמעה רבה', 'שמעה  רבה!', 'ראתה']), 'he', [], 'ru').ok).toBe(false);
    });
  });

  // Review: save-all stores every sense of a word, so one batch can hold the
  // same form twice. One sense's translation is a right answer on the other.
  describe('another saved meaning of the same word', () => {
    const polysemy = meaningItems([
      { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null },
      { senseId: 's2', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'קשת', example: null, exampleTranslation: null },
      { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'хлеб', lemma: 'хлеб', partOfSpeech: 'noun', translation: 'לחם', example: null, exampleTranslation: null },
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
        const verdict = validateDistractors(polysemy, batch(['חציל', offered, 'מלפפון']), 'he', [], 'ru');
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toContain('q1');
      }
    });

    it('accepts the same text on an item of a different word', () => {
      expect(validateDistractors(polysemy, batch(['חציל', 'מלפפון', 'עגבניה'], ['קשת', 'חלב', 'ביצה']), 'he', [], 'ru').ok).toBe(true);
    });
  });
});

// Review: the script a reversed card's wrong options must avoid is the
// explanation language's, not Hebrew's. A legacy learner of Hebrew explained
// in English gets Hebrew options and English prompts.
describe('a learner of Hebrew explained in English', () => {
  const HEBREW_WORDS: GenerationContext[] = [
    { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'ספר', lemma: 'ספר', partOfSpeech: 'noun', translation: 'book', example: null, exampleTranslation: null },
    { senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'חלון', lemma: 'חלון', partOfSpeech: 'noun', translation: 'window', example: null, exampleTranslation: null },
  ];
  const items = distractorItems(HEBREW_WORDS, (['reverse_choice', 'typed_translation'] as QuestionType[]).map(taskFor), NO_RECENT);

  it('accepts Hebrew wrong words and refuses English ones', () => {
    const reply = (q1: string[]) => ({ items: [{ key: 'q1', distractors: q1 }, { key: 'q2', distractors: [] }] });
    expect(validateDistractors(items, reply(['עט', 'דף', 'שולחן']), 'en', [], 'ru').ok).toBe(true);
    expect(validateDistractors(items, reply(['עט', 'pen', 'שולחן']), 'en', [], 'ru').ok).toBe(false);
  });

  it('keeps Hebrew alternatives and drops English ones', () => {
    const verdict = validateDistractors(
      items,
      { items: [{ key: 'q1', distractors: ['עט', 'דף', 'שולחן'] }, { key: 'q2', distractors: [], alternatives: ['אשנב', 'pane'] }] },
      'en',
      [],
      'ru',
    );
    expect(verdict.ok && verdict.byKey.get('q2')!.alternatives).toEqual(['אשנב']);
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
    { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר', example: null, exampleTranslation: null },
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
    const verdict = validateDistractors(MIXED, reply(['чеснок', 'морковь', 'капуста']), 'he', [], 'ru');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.byKey.get('q2')).toEqual({ ...NOTHING_GENERATED, distractors: ['чеснок', 'морковь', 'капуста'] });
  });

  it('refuses Hebrew, or the word itself, among a word item’s wrong options', () => {
    expect(validateDistractors(MIXED, reply(['чеснок', 'בצל', 'капуста']), 'he', [], 'ru').ok).toBe(false);
    expect(validateDistractors(MIXED, reply(['чеснок', 'лук', 'капуста']), 'he', [], 'ru').ok).toBe(false);
    expect(validateDistractors(MIXED, reply(['чеснок', 'Лук.', 'капуста']), 'he', [], 'ru').ok).toBe(false);
  });

  it('refuses, on a word item, another item’s word that has the same meaning', () => {
    const same = distractorItems(
      [
        { senseId: 'a', variantId: 'va', lexemeId: 'la', form: 'bella', lemma: 'bello', partOfSpeech: 'adjective', translation: 'יפה', example: null, exampleTranslation: null },
        { senseId: 'b', variantId: 'vb', lexemeId: 'lb', form: 'carina', lemma: 'carino', partOfSpeech: 'adjective', translation: 'יפה', example: null, exampleTranslation: null },
      ],
      ['word', 'word'],
      NO_RECENT,
    );
    const verdict = validateDistractors(same, {
      items: [
        { key: 'q1', distractors: ['brutta', 'carina', 'alta'] },
        { key: 'q2', distractors: ['brutta', 'bassa', 'alta'] },
      ],
    }, 'he', [], 'ru');
    expect(verdict.ok).toBe(false);
  });

  // Review Focus 4: alternatives may be missing or messy; never fail a session.
  it('accepts a typed item with no alternatives key, and ignores its distractors', () => {
    const verdict = validateDistractors(MIXED, reply(['чеснок', 'морковь', 'капуста'], { distractors: ['a', 'b', 'c'] }), 'he', [], 'ru');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.byKey.get('q3')).toEqual(NOTHING_GENERATED);
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
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.byKey.get('q3')!.alternatives).toEqual(['скоро', 'живо', 'шибко', 'резво', 'стремительно']);
      expect(verdict.byKey.get('q3')!.alternatives).toHaveLength(MAX_ALTERNATIVES);
    }
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
    const plan = planSession(
      Array.from({ length: 10 }, (_, i) => ({ form: `w${i}`, translation: `מ${i}`, tiles: true, speakable: false, clozeGap: false })),
      { listening: true, speaking: false, ordinal: 0 },
    );
    expect(tasksFor(plan)).toEqual(['meaning', 'word', 'typed', 'meaning', null, null, null, 'meaning', null, null]);
  });

  it('keys an item by its position, whichever positions ask nothing', () => {
    const rows = ['a', 'b', 'c'].map((form) => ({ ...CONTEXT[0], form, lemma: form }));
    expect(distractorItems(rows, ['meaning', null, 'typed'], NO_RECENT).map((item) => item.key)).toEqual(['q1', 'q3']);
  });

  const row = (form: string, translation: string): GenerationContext => ({
    senseId: `s-${form}-${translation}`, variantId: `v-${form}`, lexemeId: `l-${form}`, form, lemma: form, partOfSpeech: 'noun', translation, example: null, exampleTranslation: null,
  });

  it("takes a board's fifth meaning from the first wrong one that is none of its four", () => {
    const board = [row('a', 'בית'), row('b', 'דלי'), row('c', 'עץ'), row('d', 'סיר')];
    expect(boardMeanings(board, board, ['דלי', 'שולחן', 'כיסא'])).toEqual(['בית', 'דלי', 'עץ', 'סיר', 'שולחן']);
    expect(boardMeanings(board, board, ['בית ', 'דלי', 'עץ'])).toBeNull();
  });

  // Review (final), reproduction (b): a board word's other saved meaning is
  // not a wrong meaning for the board's fifth place.
  it("never takes a board word's other saved meaning as the fifth meaning", () => {
    const board = [row('замок', 'טירה'), row('b', 'דלי'), row('c', 'עץ'), row('d', 'סיר')];
    const session = [...board, row('замок', 'מנעול')];
    expect(boardMeanings(board, session, ['מנעול', 'שולחן', 'כיסא'])).toEqual(['טירה', 'דלי', 'עץ', 'סיר', 'שולחן']);
    expect(boardMeanings(board, session, ['מנעול', 'מנעול.', 'טירה'])).toBeNull();
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
});

// Review (final), Important 1: rows that ask the model nothing (a dictation, a
// tiles card, a board's later words) are still in the session.
describe('rows that ask the model nothing', () => {
  const castle = distractorItems(
    [{ senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'замок', lemma: 'замок', partOfSpeech: 'noun', translation: 'טירה', example: null, exampleTranslation: null }],
    ['meaning'],
    NO_RECENT,
  );
  const reply = (wrong: string[]) => ({ items: [{ key: 'q1', distractors: wrong }] });
  const LOCK = [{ form: 'замок', translation: 'מנעול' }];

  it("refuses another meaning of the item's word that a dictation holds (reproduction a)", () => {
    const verdict = validateDistractors(castle, reply(['מנעול', 'שולחן', 'כיסא']), 'he', LOCK, 'ru');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('another meaning of the same word');
    expect(validateDistractors(castle, reply(['מנעול', 'שולחן', 'כיסא']), 'he', [], 'ru').ok).toBe(true);
    expect(validateDistractors(castle, reply(['שולחן', 'כיסא', 'עט']), 'he', LOCK, 'ru').ok).toBe(true);
  });

  it('refuses, on a word item, the word of another row with the same meaning', () => {
    const word = distractorItems(
      [{ senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל', example: null, exampleTranslation: null }],
      ['word'],
      NO_RECENT,
    );
    const verdict = validateDistractors(word, reply(['чеснок', 'морковь', 'репка']), 'he', [{ form: 'репка', translation: 'בצל' }], 'ru');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('same meaning');
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

describe('phase 25 generation', () => {
  const row = { senseId: 's', variantId: 'v', lexemeId: 'l', form: 'gatto', lemma: 'gatto', partOfSpeech: 'noun', translation: 'חתול', example: null, exampleTranslation: null };
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
    senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'parlare', lemma: 'parlare', partOfSpeech: 'verb', translation: 'לדבר',
    example: 'Mi piace parlare con te.', exampleTranslation: 'אני אוהב לדבר איתך.',
  };

  it('asks the three new types for gap, sentence and translate', () => {
    expect(taskFor('cloze_choice')).toBe('gap');
    expect(taskFor('cloze_typed')).toBe('sentence');
    expect(taskFor('sentence_translation')).toBe('translate');
  });

  describe('distractorItems', () => {
    const recent: RecentSentences = new Map([
      ['s1', { cloze: ['A uno.', 'B due.', 'C tre.', 'D quattro.'], translate: ['אחת', 'שתיים', 'שלוש', 'ארבע'] }],
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
    it('avoids the three newest recent translations on a translate item', () => {
      expect(distractorItems([ROW], ['translate'], recent)[0].avoid).toEqual(['אחת', 'שתיים', 'שלוש']);
    });
    it('avoids nothing on any other item, and finds a gap item its blank', () => {
      expect(distractorItems([ROW], ['meaning'], recent)[0].avoid).toEqual([]);
      expect(distractorItems([ROW], ['gap'], recent)[0]).toMatchObject({ avoid: [], blank: 'parlare' });
      expect(distractorItems([ROW], ['word'], recent)[0].blank).toBeNull();
    });
  });

  describe('buildDistractorPrompt', () => {
    const items = [
      ...distractorItems([ROW], ['gap'], NO_RECENT),
      ...distractorItems([ROW], ['sentence'], NO_RECENT).map((item) => ({ ...item, key: 'q2' })),
      ...distractorItems([ROW], ['translate'], new Map([['s1', { cloze: [], translate: ['אחת'] }]])).map((item) => ({ ...item, key: 'q3' })),
    ];
    const prompt = buildDistractorPrompt({ items, from: 'it', to: 'he', others: [] });
    it('describes the three tasks and keeps the marker', () => {
      expect(prompt.system).toContain('- "gap":');
      expect(prompt.system).toContain('- "sentence":');
      expect(prompt.system).toContain('- "translate":');
      expect(prompt.system).toContain('3 to 12 words');
      expect(prompt.system).toContain('3 to 10 words');
      expect(prompt.system).toContain(DISTRACTOR_MARKER);
    });
    it('sends the example, its translation and the sentences to avoid', () => {
      const sent = JSON.parse(prompt.user) as { items: Record<string, unknown>[] };
      expect(sent.items[0]).toMatchObject({
        key: 'q1', task: 'gap', example: ROW.example, example_translation: ROW.exampleTranslation, sentence: ROW.example, blank: 'parlare',
      });
      expect(sent.items[0]).not.toHaveProperty('avoid');
      expect(sent.items[1]).toMatchObject({ task: 'sentence', avoid: ['Mi piace parlare con te.'] });
      expect(sent.items[2]).toMatchObject({ task: 'translate', avoid: ['אחת'] });
    });
  });

  describe('validateDistractors', () => {
    const gapItem = distractorItems([ROW], ['gap'], NO_RECENT);
    const gapReply = (wrong: string[]) => ({ items: [{ key: 'q1', distractors: wrong }] });
    it('takes a gap item as three wrong target words', () => {
      const verdict = validateDistractors(gapItem, gapReply(['parlai', 'parlato', 'parlò']), 'he', [], 'it');
      expect(verdict.ok && verdict.byKey.get('q1')).toEqual({
        distractors: ['parlai', 'parlato', 'parlò'], alternatives: [], sentence: null, translate: null, degraded: null,
      });
    });
    it('refuses a gap item that offers the form, the lemma, a Hebrew word or too few', () => {
      expect(validateDistractors(gapItem, gapReply(['parlai', 'Parlare', 'parlò']), 'he', [], 'it').ok).toBe(false);
      expect(validateDistractors(gapItem, gapReply(['parlai', 'דיבר', 'parlò']), 'he', [], 'it').ok).toBe(false);
      expect(validateDistractors(gapItem, gapReply(['parlai', 'parlò']), 'he', [], 'it').ok).toBe(false);
    });
    it('refuses a gap item that offers its own blank when the blank is another form', () => {
      const inflected = distractorItems([{ ...ROW, form: 'parlavamo', lemma: 'parlare', example: 'Ieri parlavamo per ore.' }], ['gap'], NO_RECENT);
      expect(validateDistractors(inflected, gapReply(['parlai', 'parlavamo', 'parlò']), 'he', [], 'it').ok).toBe(false);
    });
    it('refuses a gap item that offers the lemma when the blank is an inflected form', () => {
      const inflected = distractorItems([{ ...ROW, form: 'parlavamo', lemma: 'parlare', example: 'Ieri parlavamo per ore.' }], ['gap'], NO_RECENT);
      expect(validateDistractors(inflected, gapReply(['parlai', 'parlare', 'parlò']), 'he', [], 'it').ok).toBe(false);
    });

    const SENTENCE = distractorItems([ROW], ['sentence'], NO_RECENT);
    const TRANSLATE = distractorItems([ROW], ['translate'], NO_RECENT);
    it('keeps the validated content of a sentence item', () => {
      const verdict = validateDistractors(SENTENCE, {
        items: [{ key: 'q1', distractors: [], sentence: 'Ieri parlavamo per ore.', gap: 'parlavamo', translation: 'אתמול דיברנו שעות.' }],
      }, 'he', [], 'it');
      expect(verdict.ok && verdict.byKey.get('q1')).toEqual({
        distractors: [], alternatives: [], degraded: null, translate: null,
        sentence: { sentence: 'Ieri parlavamo per ore.', translation: 'אתמול דיברנו שעות.', gap: { start: 5, end: 14 }, alternatives: [] },
      });
    });
    it('never refuses for a sentence or translate item: it degrades with the reason', () => {
      const verdict = validateDistractors([...SENTENCE, ...TRANSLATE.map((item) => ({ ...item, key: 'q2' }))], {
        items: [{ key: 'q1', distractors: [] }, { key: 'q2', distractors: [], sentence: 'אנא', translation: 'x', gap: 'y' }],
      }, 'he', [], 'it');
      expect(verdict.ok).toBe(true);
      const byKey = verdict.ok ? verdict.byKey : new Map();
      expect(byKey.get('q1')).toMatchObject({ sentence: null, translate: null, degraded: expect.any(String) });
      expect(byKey.get('q2')).toMatchObject({ sentence: null, translate: null, degraded: expect.any(String) });
    });
    it('keeps the validated content of a translate item', () => {
      const verdict = validateDistractors(TRANSLATE, {
        items: [{ key: 'q1', distractors: [], sentence: 'דיברנו שעות רבות', translation: 'Abbiamo parlato per ore.', gap: 'parlato' }],
      }, 'he', [], 'it');
      expect(verdict.ok && verdict.byKey.get('q1')).toMatchObject({
        sentence: null, degraded: null,
        translate: { hebrew: 'דיברנו שעות רבות', reference: 'Abbiamo parlato per ore.', gap: { start: 8, end: 15 } },
      });
    });
    it('degrades an item the model did not answer at all, but still refuses the batch for a choice item', () => {
      const none = validateDistractors(SENTENCE, { items: [] }, 'he', [], 'it');
      expect(none.ok && none.byKey.get('q1')?.degraded).toEqual(expect.any(String));
      expect(validateDistractors(gapItem, { items: [] }, 'he', [], 'it').ok).toBe(false);
    });
  });

  describe('generatedContent', () => {
    const nothing = { prompt: null, options: null, alternatives: null, tiles: null, ...NO_SENTENCE };
    const extras = { ...NO_EXTRAS, gap: { start: 9, end: 16 } };
    it('stores a cloze choice from the saved example, the gap text correct first', () => {
      const content = generatedContent(ROW, 'cloze_choice', { ...NOTHING_GENERATED, distractors: ['parlai', 'parlato', 'parlò'] }, extras);
      expect(content).toEqual({
        ...nothing,
        prompt: 'לדבר',
        options: optionsFor('parlare', ['parlai', 'parlato', 'parlò']),
        sentence: ROW.example,
        sentenceTranslation: ROW.exampleTranslation,
        gapStart: 9,
        gapEnd: 16,
      });
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

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
} from './distractors';
import { planSession } from './plan';

/** Items for today's card only, as every batch was before phase 23. */
const meaningItems = (context: GenerationContext[]) =>
  distractorItems(context, context.map((): QuestionType => 'multiple_choice').map(taskFor));

const CONTEXT: GenerationContext[] = [
  { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה' },
  { senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל' },
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
    const verdict = validateDistractors(ITEMS, answer([' כתבה', 'שמעה', 'ראתה ']), 'he', []);
    expect(verdict).toEqual({
      ok: true,
      byKey: new Map([
        ['q1', { distractors: ['כתבה', 'שמעה', 'ראתה'], alternatives: [] }],
        ['q2', { distractors: ['קשת', 'שום', 'גזר'], alternatives: [] }],
      ]),
    });
  });

  it('ignores keys nobody asked for', () => {
    const verdict = validateDistractors(ITEMS, {
      items: [...answer(['כתבה', 'שמעה', 'ראתה']).items, { key: 'q9', distractors: ['x', 'y', 'z'] }],
    }, 'he', []);
    expect(verdict.ok).toBe(true);
  });

  it('refuses an item with no answer', () => {
    const verdict = validateDistractors(ITEMS, { items: [{ key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] }] }, 'he', []);
    expect(verdict).toEqual({ ok: false, reason: 'no answer for q2' });
  });

  it('refuses fewer than three wrong answers on a choice item', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', 'שמעה']), 'he', []).ok).toBe(false);
  });

  it('refuses an empty distractor', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', '  ', 'ראתה']), 'he', []).ok).toBe(false);
  });

  // Review Focus 4: the right answer in disguise.
  it.each([['קראה'], ['קראה '], ['קראה.']])('refuses the correct answer as a distractor: %j', (disguised) => {
    expect(validateDistractors(ITEMS, answer(['כתבה', disguised, 'ראתה']), 'he', []).ok).toBe(false);
  });

  it('refuses two equal distractors', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', 'כתבה', 'ראתה']), 'he', []).ok).toBe(false);
  });

  // The comparison is the validator's own: a multi-word answer keeps its mark
  // in a dictionary key, but here "the same option" ignores it, and nikud.
  describe('multi-word answers and pointed copies', () => {
    const phrase = meaningItems([
      { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'большое спасибо', lemma: 'спасибо', partOfSpeech: 'phrase', translation: 'תודה רבה' },
    ]);
    const one = (distractors: string[]) => ({ items: [{ key: 'q1', distractors }] });

    it.each([['תודה רבה.'], ['תודה רבה!'], ['תודה  רבה'], ['תודה רבה…'], ['תודה רבה?!']])(
      'refuses the multi-word answer in disguise: %j',
      (disguised) => {
        expect(validateDistractors(phrase, one(['כתבה', disguised, 'ראתה']), 'he', []).ok).toBe(false);
      },
    );

    it('accepts a different multi-word option', () => {
      expect(validateDistractors(phrase, one(['בבקשה רבה', 'להתראות', 'ערב טוב']), 'he', []).ok).toBe(true);
    });

    it('refuses a pointed copy of the answer', () => {
      expect(validateDistractors(ITEMS, answer(['כתבה', 'קָרָאָה', 'ראתה']), 'he', []).ok).toBe(false);
    });

    it('counts two distractors that differ only in points, marks or spacing as equal', () => {
      expect(validateDistractors(phrase, one(['כתבה', 'כָּתְבָה', 'כתבה.']), 'he', []).ok).toBe(false);
      expect(validateDistractors(phrase, one(['שמעה רבה', 'שמעה  רבה!', 'ראתה']), 'he', []).ok).toBe(false);
    });
  });

  // Review: save-all stores every sense of a word, so one batch can hold the
  // same form twice. One sense's translation is a right answer on the other.
  describe('another saved meaning of the same word', () => {
    const polysemy = meaningItems([
      { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל' },
      { senseId: 's2', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'קשת' },
      { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'хлеб', lemma: 'хлеб', partOfSpeech: 'noun', translation: 'לחם' },
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
        const verdict = validateDistractors(polysemy, batch(['חציל', offered, 'מלפפון']), 'he', []);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toContain('q1');
      }
    });

    it('accepts the same text on an item of a different word', () => {
      expect(validateDistractors(polysemy, batch(['חציל', 'מלפפון', 'עגבניה'], ['קשת', 'חלב', 'ביצה']), 'he', []).ok).toBe(true);
    });
  });
});

// Review: the script a reversed card's wrong options must avoid is the
// explanation language's, not Hebrew's. A legacy learner of Hebrew explained
// in English gets Hebrew options and English prompts.
describe('a learner of Hebrew explained in English', () => {
  const HEBREW_WORDS: GenerationContext[] = [
    { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'ספר', lemma: 'ספר', partOfSpeech: 'noun', translation: 'book' },
    { senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'חלון', lemma: 'חלון', partOfSpeech: 'noun', translation: 'window' },
  ];
  const items = distractorItems(HEBREW_WORDS, (['reverse_choice', 'typed_translation'] as QuestionType[]).map(taskFor));

  it('accepts Hebrew wrong words and refuses English ones', () => {
    const reply = (q1: string[]) => ({ items: [{ key: 'q1', distractors: q1 }, { key: 'q2', distractors: [] }] });
    expect(validateDistractors(items, reply(['עט', 'דף', 'שולחן']), 'en', []).ok).toBe(true);
    expect(validateDistractors(items, reply(['עט', 'pen', 'שולחן']), 'en', []).ok).toBe(false);
  });

  it('keeps Hebrew alternatives and drops English ones', () => {
    const verdict = validateDistractors(
      items,
      { items: [{ key: 'q1', distractors: ['עט', 'דף', 'שולחן'] }, { key: 'q2', distractors: [], alternatives: ['אשנב', 'pane'] }] },
      'en',
      [],
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
    { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'быстро', lemma: 'быстро', partOfSpeech: 'adverb', translation: 'מהר' },
  ];
  const TYPES: QuestionType[] = ['multiple_choice', 'reverse_choice', 'typed_translation'];
  const MIXED = distractorItems(CONTEXT3, TYPES.map(taskFor));
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
    const verdict = validateDistractors(MIXED, reply(['чеснок', 'морковь', 'капуста']), 'he', []);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.byKey.get('q2')).toEqual({ distractors: ['чеснок', 'морковь', 'капуста'], alternatives: [] });
  });

  it('refuses Hebrew, or the word itself, among a word item’s wrong options', () => {
    expect(validateDistractors(MIXED, reply(['чеснок', 'בצל', 'капуста']), 'he', []).ok).toBe(false);
    expect(validateDistractors(MIXED, reply(['чеснок', 'лук', 'капуста']), 'he', []).ok).toBe(false);
    expect(validateDistractors(MIXED, reply(['чеснок', 'Лук.', 'капуста']), 'he', []).ok).toBe(false);
  });

  it('refuses, on a word item, another item’s word that has the same meaning', () => {
    const same = distractorItems(
      [
        { senseId: 'a', variantId: 'va', lexemeId: 'la', form: 'bella', lemma: 'bello', partOfSpeech: 'adjective', translation: 'יפה' },
        { senseId: 'b', variantId: 'vb', lexemeId: 'lb', form: 'carina', lemma: 'carino', partOfSpeech: 'adjective', translation: 'יפה' },
      ],
      ['word', 'word'],
    );
    const verdict = validateDistractors(same, {
      items: [
        { key: 'q1', distractors: ['brutta', 'carina', 'alta'] },
        { key: 'q2', distractors: ['brutta', 'bassa', 'alta'] },
      ],
    }, 'he', []);
    expect(verdict.ok).toBe(false);
  });

  // Review Focus 4: alternatives may be missing or messy; never fail a session.
  it('accepts a typed item with no alternatives key, and ignores its distractors', () => {
    const verdict = validateDistractors(MIXED, reply(['чеснок', 'морковь', 'капуста'], { distractors: ['a', 'b', 'c'] }), 'he', []);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.byKey.get('q3')).toEqual({ distractors: [], alternatives: [] });
  });

  it('cleans a typed item’s alternatives instead of refusing them', () => {
    const verdict = validateDistractors(
      MIXED,
      reply(['чеснок', 'морковь', 'капуста'], {
        alternatives: [' скоро ', '', 'מהר', 'быстро', 'Скоро', 'живо', 'шибко', 'резво', 'стремительно', 'проворно'],
      }),
      'he',
      [],
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.byKey.get('q3')!.alternatives).toEqual(['скоро', 'живо', 'шибко', 'резво', 'стремительно']);
      expect(verdict.byKey.get('q3')!.alternatives).toHaveLength(MAX_ALTERNATIVES);
    }
  });

  it('builds each type’s stored content', () => {
    const generated = { distractors: ['a', 'b', 'c'], alternatives: ['x'] };
    expect(generatedContent(CONTEXT3[0], 'multiple_choice', generated, NO_EXTRAS)).toEqual({
      prompt: null,
      options: optionsFor('קראה', ['a', 'b', 'c']),
      alternatives: null,
      tiles: null,
    });
    expect(generatedContent(CONTEXT3[1], 'reverse_choice', generated, NO_EXTRAS)).toEqual({
      prompt: 'בצל',
      options: optionsFor('лук', ['a', 'b', 'c']),
      alternatives: null,
      tiles: null,
    });
    expect(generatedContent(CONTEXT3[2], 'typed_translation', generated, NO_EXTRAS)).toEqual({
      prompt: 'מהר',
      options: null,
      alternatives: ['x'],
      tiles: null,
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
      Array.from({ length: 10 }, (_, i) => ({ form: `w${i}`, translation: `מ${i}`, tiles: true, speakable: false })),
      { listening: true, speaking: false, ordinal: 0 },
    );
    expect(tasksFor(plan)).toEqual(['meaning', 'word', 'typed', 'meaning', null, null, null, 'meaning', null, null]);
  });

  it('keys an item by its position, whichever positions ask nothing', () => {
    const rows = ['a', 'b', 'c'].map((form) => ({ ...CONTEXT[0], form, lemma: form }));
    expect(distractorItems(rows, ['meaning', null, 'typed']).map((item) => item.key)).toEqual(['q1', 'q3']);
  });

  const row = (form: string, translation: string): GenerationContext => ({
    senseId: `s-${form}-${translation}`, variantId: `v-${form}`, lexemeId: `l-${form}`, form, lemma: form, partOfSpeech: 'noun', translation,
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
    expect(generatedContent(ROW, 'listen_choice', { distractors: ['א', 'ב', 'ג'], alternatives: [] }, NO_EXTRAS)).toMatchObject({
      prompt: null, alternatives: null, tiles: null,
    });
    expect(generatedContent(ROW, 'dictation', NOTHING_GENERATED, NO_EXTRAS)).toEqual({
      prompt: ROW.translation, options: null, alternatives: null, tiles: null,
    });
    expect(generatedContent(ROW, 'letter_tiles', NOTHING_GENERATED, { tiles: ['a', 'b', 'c', 'd', 'e'], board: null })).toEqual({
      prompt: ROW.translation, options: null, alternatives: null, tiles: ['a', 'b', 'c', 'd', 'e'],
    });
    const board = generatedContent(ROW, 'matching', NOTHING_GENERATED, {
      tiles: null,
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
    [{ senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'замок', lemma: 'замок', partOfSpeech: 'noun', translation: 'טירה' }],
    ['meaning'],
  );
  const reply = (wrong: string[]) => ({ items: [{ key: 'q1', distractors: wrong }] });
  const LOCK = [{ form: 'замок', translation: 'מנעול' }];

  it("refuses another meaning of the item's word that a dictation holds (reproduction a)", () => {
    const verdict = validateDistractors(castle, reply(['מנעול', 'שולחן', 'כיסא']), 'he', LOCK);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('another meaning of the same word');
    expect(validateDistractors(castle, reply(['מנעול', 'שולחן', 'כיסא']), 'he', []).ok).toBe(true);
    expect(validateDistractors(castle, reply(['שולחן', 'כיסא', 'עט']), 'he', LOCK).ok).toBe(true);
  });

  it('refuses, on a word item, the word of another row with the same meaning', () => {
    const word = distractorItems(
      [{ senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל' }],
      ['word'],
    );
    const verdict = validateDistractors(word, reply(['чеснок', 'морковь', 'репка']), 'he', [{ form: 'репка', translation: 'בצל' }]);
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
  const row = { senseId: 's', variantId: 'v', lexemeId: 'l', form: 'gatto', lemma: 'gatto', partOfSpeech: 'noun', translation: 'חתול' };
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
    });
    expect(generatedContent(row, 'say_translation', { distractors: [], alternatives: ['micio'] }, NO_EXTRAS)).toEqual({
      prompt: 'חתול',
      options: null,
      alternatives: ['micio'],
      tiles: null,
    });
  });
});

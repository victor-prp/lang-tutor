import { describe, expect, it } from '@jest/globals';

import {
  DISTRACTOR_MARKER,
  buildDistractorPrompt,
  distractorItems,
  optionsFor,
  parseLlmDistractors,
  validateDistractors,
  type GenerationContext,
} from './distractors';

const CONTEXT: GenerationContext[] = [
  { senseId: 's1', variantId: 'v1', lexemeId: 'l1', form: 'прочитала', lemma: 'прочитать', partOfSpeech: 'verb', translation: 'קראה' },
  { senseId: 's2', variantId: 'v2', lexemeId: 'l2', form: 'лук', lemma: 'лук', partOfSpeech: 'noun', translation: 'בצל' },
];
const ITEMS = distractorItems(CONTEXT);

describe('distractorItems', () => {
  it('keys items q1, q2, … in input order', () => {
    expect(ITEMS.map((item) => item.key)).toEqual(['q1', 'q2']);
    expect(ITEMS[1]).toMatchObject({ form: 'лук', translation: 'בצל' });
  });
});

describe('buildDistractorPrompt for Italian', () => {
  it('names Italian and Hebrew', () => {
    const prompt = buildDistractorPrompt({ items: ITEMS, from: 'it', to: 'he' });
    expect(prompt.system).toContain('Italian');
    expect(prompt.system).toContain('Hebrew');
  });
});

describe('buildDistractorPrompt', () => {
  const prompt = buildDistractorPrompt({ items: ITEMS, from: 'ru', to: 'he' });

  it('names the languages and carries the marker MockServer matches on', () => {
    expect(prompt.system).toContain('Russian');
    expect(prompt.system).toContain('Hebrew');
    expect(prompt.system).toContain(DISTRACTOR_MARKER);
  });

  it('tells the model that items sharing a word must not offer each other’s answers', () => {
    expect(prompt.system).toContain('share a word');
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
    expect(() => buildDistractorPrompt({ items: ITEMS, from: 'xx', to: 'he' })).toThrow('xx');
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
    expect(parseLlmDistractors(JSON.stringify({ items: [{ key: 'q1', distractors: ['a', 'b'] }] }))).toBeNull();
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
    const verdict = validateDistractors(ITEMS, answer([' כתבה', 'שמעה', 'ראתה ']));
    expect(verdict).toEqual({
      ok: true,
      byKey: new Map([
        ['q1', ['כתבה', 'שמעה', 'ראתה']],
        ['q2', ['קשת', 'שום', 'גזר']],
      ]),
    });
  });

  it('ignores keys nobody asked for', () => {
    const verdict = validateDistractors(ITEMS, {
      items: [...answer(['כתבה', 'שמעה', 'ראתה']).items, { key: 'q9', distractors: ['x', 'y', 'z'] }],
    });
    expect(verdict.ok).toBe(true);
  });

  it('refuses an item with no answer', () => {
    const verdict = validateDistractors(ITEMS, { items: [{ key: 'q1', distractors: ['כתבה', 'שמעה', 'ראתה'] }] });
    expect(verdict).toEqual({ ok: false, reason: 'no answer for q2' });
  });

  it('refuses an empty distractor', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', '  ', 'ראתה'])).ok).toBe(false);
  });

  // Review Focus 4: the right answer in disguise.
  it.each([['קראה'], ['קראה '], ['קראה.']])('refuses the correct answer as a distractor: %j', (disguised) => {
    expect(validateDistractors(ITEMS, answer(['כתבה', disguised, 'ראתה'])).ok).toBe(false);
  });

  it('refuses two equal distractors', () => {
    expect(validateDistractors(ITEMS, answer(['כתבה', 'כתבה', 'ראתה'])).ok).toBe(false);
  });

  // The comparison is the validator's own: a multi-word answer keeps its mark
  // in a dictionary key, but here "the same option" ignores it, and nikud.
  describe('multi-word answers and pointed copies', () => {
    const phrase = distractorItems([
      { senseId: 's3', variantId: 'v3', lexemeId: 'l3', form: 'большое спасибо', lemma: 'спасибо', partOfSpeech: 'phrase', translation: 'תודה רבה' },
    ]);
    const one = (distractors: string[]) => ({ items: [{ key: 'q1', distractors }] });

    it.each([['תודה רבה.'], ['תודה רבה!'], ['תודה  רבה'], ['תודה רבה…'], ['תודה רבה?!']])(
      'refuses the multi-word answer in disguise: %j',
      (disguised) => {
        expect(validateDistractors(phrase, one(['כתבה', disguised, 'ראתה'])).ok).toBe(false);
      },
    );

    it('accepts a different multi-word option', () => {
      expect(validateDistractors(phrase, one(['בבקשה רבה', 'להתראות', 'ערב טוב'])).ok).toBe(true);
    });

    it('refuses a pointed copy of the answer', () => {
      expect(validateDistractors(ITEMS, answer(['כתבה', 'קָרָאָה', 'ראתה'])).ok).toBe(false);
    });

    it('counts two distractors that differ only in points, marks or spacing as equal', () => {
      expect(validateDistractors(phrase, one(['כתבה', 'כָּתְבָה', 'כתבה.'])).ok).toBe(false);
      expect(validateDistractors(phrase, one(['שמעה רבה', 'שמעה  רבה!', 'ראתה'])).ok).toBe(false);
    });
  });

  // Review: save-all stores every sense of a word, so one batch can hold the
  // same form twice. One sense's translation is a right answer on the other.
  describe('another saved meaning of the same word', () => {
    const polysemy = distractorItems([
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
        const verdict = validateDistractors(polysemy, batch(['חציל', offered, 'מלפפון']));
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toContain('q1');
      }
    });

    it('accepts the same text on an item of a different word', () => {
      expect(validateDistractors(polysemy, batch(['חציל', 'מלפפון', 'עגבניה'], ['קשת', 'חלב', 'ביצה'])).ok).toBe(true);
    });
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

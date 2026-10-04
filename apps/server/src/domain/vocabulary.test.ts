import { describe, expect, it } from '@jest/globals';

import {
  assemblePage,
  buildWordDetail,
  coversPair,
  decodeCursor,
  encodeCursor,
  firstPerSense,
  markSaved,
  type LexemeRendering,
  type WordSummary,
} from './vocabulary';

describe('the cursor', () => {
  const cursorOf = (savedAt: string, lexemeId: string) =>
    Buffer.from(JSON.stringify([savedAt, lexemeId]), 'utf8').toString('base64url');
  const cursor = { savedAt: '2026-10-04 12:00:00.123456+00', lexemeId: 'lx-1' };

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('accepts a leap day in a leap year and every offset form the server issues', () => {
    for (const savedAt of [
      '2028-02-29 23:59:59.999999+00',
      '2026-10-04 12:00:00.1-08',
      '2026-10-04 12:00:00+05:45',
      '2026-10-04 00:00:00-03:30',
    ]) {
      expect(decodeCursor(cursorOf(savedAt, 'lx-1'))).toEqual({ savedAt, lexemeId: 'lx-1' });
    }
  });

  it('round-trips a whole second and an offset with minutes', () => {
    const plain = { savedAt: '2026-10-04 12:00:00+05:30', lexemeId: 'lx-2' };
    expect(decodeCursor(encodeCursor(plain))).toEqual(plain);
  });

  it.each([
    ['not base64 json', '!!!'],
    ['an object', Buffer.from('{"a":1}').toString('base64url')],
    ['a junk timestamp', Buffer.from('["yesterday","lx-1"]').toString('base64url')],
    ['an empty lexeme id', Buffer.from('["2026-10-04 12:00:00+00",""]').toString('base64url')],
    ['three elements', Buffer.from('["2026-10-04 12:00:00+00","a","b"]').toString('base64url')],
    ['a well-shaped but out-of-range timestamp', cursorOf('2026-13-45 25:61:00+00', 'lx-1')],
    ['a day the month does not have', cursorOf('2026-02-30 12:00:00+00', 'lx-1')],
    ['a leap day in a common year', cursorOf('2026-02-29 12:00:00+00', 'lx-1')],
    ['an hour of 24', cursorOf('2026-10-04 24:00:00+00', 'lx-1')],
    ['a second of 60', cursorOf('2026-10-04 12:00:60+00', 'lx-1')],
    ['an offset of 99 hours', cursorOf('2026-10-04 12:00:00+99', 'lx-1')],
    ['an offset with 75 minutes', cursorOf('2026-10-04 12:00:00+05:75', 'lx-1')],
    ['a lexeme id containing NUL', cursorOf('2026-10-04 12:00:00+00', 'lx\u0000-1')],
  ])('refuses %s', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

const summary = (lexemeId: string, over: Partial<WordSummary> = {}): WordSummary => ({
  lexemeId,
  lemma: `lemma-${lexemeId}`,
  partOfSpeech: 'noun',
  headlineSenseId: `s-${lexemeId}`,
  headlineTranslation: `tr-${lexemeId}`,
  headlineForm: `form-${lexemeId}`,
  savedCount: 1,
  senseCount: 2,
  ...over,
});

describe('assemblePage', () => {
  it('keeps the page order, not the summaries order', () => {
    const rows = [
      { lexemeId: 'b', lastSavedAt: 't2' },
      { lexemeId: 'a', lastSavedAt: 't1' },
    ];
    const page = assemblePage(rows, [summary('a'), summary('b')]);
    expect(page.map((w) => w.lexeme_id)).toEqual(['b', 'a']);
    expect(page[0]).toEqual({
      lexeme_id: 'b',
      lemma: 'lemma-b',
      part_of_speech: 'noun',
      headline: { sense_id: 's-b', translation: 'tr-b', form: 'form-b' },
      saved_count: 1,
      sense_count: 2,
    });
  });

  // Review Focus 5: a word whose saved senses lost every rendering has no
  // headline to show. It is dropped, not served half-empty.
  it('drops a page row with no summary', () => {
    const rows = [
      { lexemeId: 'a', lastSavedAt: 't2' },
      { lexemeId: 'gone', lastSavedAt: 't1' },
    ];
    expect(assemblePage(rows, [summary('a')]).map((w) => w.lexeme_id)).toEqual(['a']);
  });
});

const rendering = (over: Partial<LexemeRendering>): LexemeRendering => ({
  senseId: 's1',
  variantId: 'v1',
  form: 'прочитать',
  rank: 0,
  translation: 'לקרוא',
  exampleSource: null,
  exampleTarget: null,
  ...over,
});

const LEXEME = { lexemeId: 'lx', lemma: 'прочитать', partOfSpeech: 'verb', languageCode: 'ru' };

describe('buildWordDetail', () => {
  it("shows a saved sense in the form it was saved from, even when the lemma's form renders it", () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ variantId: 'v-lemma', form: 'прочитать', translation: 'לקרוא' }),
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
      ],
      [{ senseId: 's1', variantId: 'v-past' }],
    );
    expect(detail.senses).toEqual([
      { sense_id: 's1', variant_id: 'v-past', form: 'прочитала', translation: 'קראה', saved: true },
    ]);
  });

  it("shows an unsaved sense in the lemma's own form when one exists", () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
        rendering({ variantId: 'v-lemma', form: 'Прочитать', translation: 'לקרוא' }),
      ],
      [],
    );
    expect(detail.senses[0]).toMatchObject({ variant_id: 'v-lemma', saved: false });
  });

  it('otherwise uses the form that renders the most of this lexeme, ties by variant id', () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ senseId: 's1', variantId: 'v-b', form: 'прочитаю' }),
        rendering({ senseId: 's2', variantId: 'v-b', form: 'прочитаю', rank: 1 }),
        rendering({ senseId: 's1', variantId: 'v-a', form: 'прочитала' }),
        rendering({ senseId: 's3', variantId: 'v-c', form: 'прочитал', rank: 2 }),
        rendering({ senseId: 's3', variantId: 'v-d', form: 'прочитали', rank: 2 }),
      ],
      [],
    );
    const shown = Object.fromEntries(detail.senses.map((s) => [s.sense_id, s.variant_id]));
    expect(shown).toEqual({ s1: 'v-b', s2: 'v-b', s3: 'v-c' });
  });

  // Review Focus 3: the saved form no longer renders the sense. A repair may not
  // drop a rendering, so this is a backstop — but it must not lose the entry.
  it('falls back to the representative rendering when the saved form no longer renders the sense', () => {
    const detail = buildWordDetail(
      LEXEME,
      [rendering({ variantId: 'v-lemma', form: 'прочитать' })],
      [{ senseId: 's1', variantId: 'v-gone' }],
    );
    expect(detail.senses).toEqual([
      expect.objectContaining({ sense_id: 's1', variant_id: 'v-lemma', saved: true }),
    ]);
  });

  it('orders saved senses first, each group by rank, then by sense id', () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ senseId: 's-a', rank: 0 }),
        rendering({ senseId: 's-b', rank: 2 }),
        rendering({ senseId: 's-c', rank: 1 }),
        rendering({ senseId: 's-d', rank: 1 }),
      ],
      [{ senseId: 's-b', variantId: 'v1' }],
    );
    expect(detail.senses.map((s) => s.sense_id)).toEqual(['s-b', 's-a', 's-c', 's-d']);
  });

  it('carries an example only when both halves are present', () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ senseId: 's1', exampleSource: 'Я прочитала книгу.', exampleTarget: 'קראתי את הספר.' }),
        rendering({ senseId: 's2', rank: 1, exampleSource: 'half', exampleTarget: null }),
      ],
      [],
    );
    expect(detail.senses[0].example).toEqual({
      source: 'Я прочитала книгу.',
      target: 'קראתי את הספר.',
    });
    expect(detail.senses[1]).not.toHaveProperty('example');
  });

  it('carries the lexeme fields', () => {
    expect(buildWordDetail(LEXEME, [], [])).toEqual({
      lexeme_id: 'lx',
      lemma: 'прочитать',
      part_of_speech: 'verb',
      senses: [],
    });
  });
});

describe('markSaved', () => {
  it('marks senses with ids and leaves a sense without ids alone', () => {
    const marked = markSaved(
      [
        { translation: 'a', sense_id: 's1', variant_id: 'v1' },
        { translation: 'b', sense_id: 's2', variant_id: 'v1' },
        { translation: 'sentence' },
      ],
      new Set(['s2']),
    );
    expect(marked.map((s) => s.saved)).toEqual([false, true, undefined]);
    expect(marked[2]).not.toHaveProperty('saved');
  });
});

describe('coversPair', () => {
  const ru = { source_language: 'he', target_language: 'ru' };

  it('covers both directions of the enrollment pair', () => {
    expect(coversPair(ru, 'ru', 'he')).toBe(true);
    expect(coversPair(ru, 'he', 'ru')).toBe(true);
  });

  it('refuses any other pair', () => {
    expect(coversPair(ru, 'en', 'he')).toBe(false);
    expect(coversPair(ru, 'he', 'en')).toBe(false);
  });
});

describe('firstPerSense', () => {
  // Review Focus 1: a double-tapped save-all sends a sense twice.
  it('keeps the first entry of each sense, in order', () => {
    expect(
      firstPerSense([
        { sense_id: 's1', variant_id: 'v1' },
        { sense_id: 's2', variant_id: 'v1' },
        { sense_id: 's1', variant_id: 'v2' },
      ]),
    ).toEqual([
      { sense_id: 's1', variant_id: 'v1' },
      { sense_id: 's2', variant_id: 'v1' },
    ]);
  });
});

import { describe, expect, it } from '@jest/globals';
import { DIMENSIONS } from '@lang-tutor/core/domain';

import type { ProgressRow } from './progress';
import {
  assemblePage,
  buildWordDetail,
  coversPair,
  cursorAfter,
  decodeCursor,
  encodeCursor,
  firstPerSense,
  markSaved,
  type LexemeRendering,
  type WordLexeme,
  type WordSummary,
} from './vocabulary';

describe('the cursor', () => {
  const cursorOf = (savedAt: string, lexemeId: string) =>
    Buffer.from(JSON.stringify([savedAt, lexemeId]), 'utf8').toString('base64url');
  const cursor = { sort: 'newest' as const, savedAt: '2026-10-04 12:00:00.123456+00', lexemeId: 'lx-1' };

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
      expect(decodeCursor(cursorOf(savedAt, 'lx-1'))).toEqual({ sort: 'newest', savedAt, lexemeId: 'lx-1' });
    }
  });

  it('round-trips a whole second and an offset with minutes', () => {
    const plain = { sort: 'newest' as const, savedAt: '2026-10-04 12:00:00+05:30', lexemeId: 'lx-2' };
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

  // Review Focus 5: a phase 18 cursor an app already holds.
  it('reads a two-element cursor as a newest-sort cursor', () => {
    expect(decodeCursor(cursorOf('2026-10-04 12:00:00+00', 'lx-1'))).toEqual({
      sort: 'newest',
      savedAt: '2026-10-04 12:00:00+00',
      lexemeId: 'lx-1',
    });
  });

  it('round-trips a level-sort cursor', () => {
    for (const sort of ['level_asc', 'level_desc'] as const) {
      const levelCursor = { sort, savedAt: '2026-10-04 12:00:00.5+00', lexemeId: 'lx-3', level: 4 };
      expect(decodeCursor(encodeCursor(levelCursor))).toEqual(levelCursor);
    }
  });

  const fourOf = (sort: unknown, level: unknown) =>
    Buffer.from(JSON.stringify(['2026-10-04 12:00:00+00', 'lx-1', sort, level]), 'utf8').toString('base64url');

  it.each([
    ['an unknown sort', fourOf('oldest', 2)],
    ['newest in the four-element form', fourOf('newest', 2)],
    ['level 0', fourOf('level_asc', 0)],
    ['level 6', fourOf('level_asc', 6)],
    ['a fractional level', fourOf('level_desc', 2.5)],
    ['a level as a string', fourOf('level_desc', '2')],
  ])('refuses a level cursor with %s', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

describe('cursorAfter', () => {
  const row = { lexemeId: 'lx-9', lastSavedAt: '2026-10-04 12:00:00+00', level: 2 };

  it('carries the level only for a level sort', () => {
    expect(cursorAfter('newest', row)).toEqual({ sort: 'newest', savedAt: row.lastSavedAt, lexemeId: 'lx-9' });
    expect(cursorAfter('level_desc', row)).toEqual({
      sort: 'level_desc',
      savedAt: row.lastSavedAt,
      lexemeId: 'lx-9',
      level: 2,
    });
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
      { lexemeId: 'b', lastSavedAt: 't2', level: 3 },
      { lexemeId: 'a', lastSavedAt: 't1', level: 1 },
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
      level: 3,
    });
  });

  // Review Focus 5: a word whose saved senses lost every rendering has no
  // headline to show. It is dropped, not served half-empty.
  it('drops a page row with no summary', () => {
    const rows = [
      { lexemeId: 'a', lastSavedAt: 't2', level: 1 },
      { lexemeId: 'gone', lastSavedAt: 't1', level: 1 },
    ];
    expect(assemblePage(rows, [summary('a')]).map((w) => w.lexeme_id)).toEqual(['a']);
  });
});

const rendering = (over: Partial<LexemeRendering>): LexemeRendering => ({
  lexemeId: 'lx',
  senseId: 's1',
  variantId: 'v1',
  form: 'прочитать',
  rank: 0,
  translation: 'לקרוא',
  exampleSource: null,
  exampleTarget: null,
  ...over,
});

const LEMMA = 'прочитать';
const VERB: WordLexeme[] = [{ lexemeId: 'lx', partOfSpeech: 'verb' }];

describe('buildWordDetail', () => {
  it("shows a saved sense in the form it was saved from, even when the lemma's form renders it", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ variantId: 'v-lemma', form: 'прочитать', translation: 'לקרוא' }),
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
      ],
      [{ senseId: 's1', variantId: 'v-past' }],
      [],
    );
    expect(detail.senses).toEqual([
      { sense_id: 's1', variant_id: 'v-past', form: 'прочитала', translation: 'קראה', part_of_speech: 'verb', saved: true },
    ]);
  });

  it("shows an unsaved sense in the lemma's own form when one exists", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
        rendering({ variantId: 'v-lemma', form: 'Прочитать', translation: 'לקרוא' }),
      ],
      [],
      [],
    );
    expect(detail.senses[0]).toMatchObject({ variant_id: 'v-lemma', saved: false });
  });

  it('otherwise uses the form that renders the most of this lexeme, ties by variant id', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ senseId: 's1', variantId: 'v-b', form: 'прочитаю' }),
        rendering({ senseId: 's2', variantId: 'v-b', form: 'прочитаю', rank: 1 }),
        rendering({ senseId: 's1', variantId: 'v-a', form: 'прочитала' }),
        rendering({ senseId: 's3', variantId: 'v-c', form: 'прочитал', rank: 2 }),
        rendering({ senseId: 's3', variantId: 'v-d', form: 'прочитали', rank: 2 }),
      ],
      [],
      [],
    );
    const shown = Object.fromEntries(detail.senses.map((s) => [s.sense_id, s.variant_id]));
    expect(shown).toEqual({ s1: 'v-b', s2: 'v-b', s3: 'v-c' });
  });

  // Review Focus 3 of phase 18: the saved form no longer renders the sense.
  it('falls back to the representative rendering when the saved form no longer renders the sense', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [rendering({ variantId: 'v-lemma', form: 'прочитать' })],
      [{ senseId: 's1', variantId: 'v-gone' }],
      [],
    );
    expect(detail.senses).toEqual([
      expect.objectContaining({ sense_id: 's1', variant_id: 'v-lemma', saved: true }),
    ]);
  });

  it('orders saved senses first, each group by rank, then by sense id', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ senseId: 's-a', rank: 0 }),
        rendering({ senseId: 's-b', rank: 2 }),
        rendering({ senseId: 's-c', rank: 1 }),
        rendering({ senseId: 's-d', rank: 1 }),
      ],
      [{ senseId: 's-b', variantId: 'v1' }],
      [],
    );
    expect(detail.senses.map((s) => s.sense_id)).toEqual(['s-b', 's-a', 's-c', 's-d']);
  });

  it('carries an example only when both halves are present', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ senseId: 's1', exampleSource: 'Я прочитала книгу.', exampleTarget: 'קראתי את הספר.' }),
        rendering({ senseId: 's2', rank: 1, exampleSource: 'half', exampleTarget: null }),
      ],
      [],
      [],
    );
    expect(detail.senses[0].example).toEqual({
      source: 'Я прочитала книгу.',
      target: 'קראתי את הספר.',
    });
    expect(detail.senses[1]).not.toHaveProperty('example');
  });

  it('carries the lemma, and no lexeme fields', () => {
    expect(buildWordDetail(LEMMA, VERB, [], [], [])).toEqual({ lemma: LEMMA, level: null, senses: [] });
  });

  const levels = (senseId: string, written: number): ProgressRow[] =>
    DIMENSIONS.map((dimension) => ({
      senseId,
      dimension,
      level: dimension === 'written_receptive' ? written : 1,
      lastStepOn: null,
      lastWrongOn: null,
    }));

  it('gives a saved sense its badge and five levels, and an unsaved one neither', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [rendering({ senseId: 's1' }), rendering({ senseId: 's2', rank: 1, translation: 'להקריא' })],
      [{ senseId: 's1', variantId: 'v1' }],
      levels('s1', 3),
    );
    expect(detail.senses[0]).toMatchObject({
      sense_id: 's1',
      progress: {
        level: 3,
        dimensions: { written_receptive: 3, written_productive: 1, spoken_receptive: 1, spoken_productive: 1, spelling: 1 },
      },
    });
    expect(detail.senses[1]).not.toHaveProperty('progress');
  });

  it("gives the word one flat mean over every saved sense's live-dimension levels, rounded once, ties up", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [rendering({ senseId: 's1' }), rendering({ senseId: 's2' })],
      [{ senseId: 's1', variantId: 'v1' }, { senseId: 's2', variantId: 'v1' }],
      [...levels('s1', 2), ...levels('s2', 3)],
    );
    expect(detail.level).toBe(3);
  });

  it('gives a word with nothing saved no level', () => {
    expect(buildWordDetail(LEMMA, VERB, [rendering({})], [], []).level).toBeNull();
  });

  describe('a lemma with two lexemes', () => {
    // знать: the verb (to know) and the noun (nobility). Ids chosen so that sense
    // id order and part-of-speech order disagree, which the ordering must survive.
    const ZNAT: WordLexeme[] = [
      { lexemeId: 'lx-noun', partOfSpeech: 'noun' },
      { lexemeId: 'lx-verb', partOfSpeech: 'verb' },
    ];
    const verb = (over: Partial<LexemeRendering>) =>
      rendering({ lexemeId: 'lx-verb', variantId: 'v-verb', form: 'знать', translation: 'לדעת', ...over });
    const noun = (over: Partial<LexemeRendering>) =>
      rendering({ lexemeId: 'lx-noun', variantId: 'v-noun', form: 'знать', translation: 'אצולה', ...over });

    it('shows every sense of both, each with its own part of speech', () => {
      const detail = buildWordDetail('знать', ZNAT, [verb({ senseId: 'a-know' }), noun({ senseId: 'z-nobility' })], [], []);
      expect(detail.senses.map((s) => [s.sense_id, s.part_of_speech])).toEqual([
        ['z-nobility', 'noun'],
        ['a-know', 'verb'],
      ]);
    });

    it('orders saved first, then by part of speech, then by rank, then by sense id', () => {
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [
          verb({ senseId: 'v1', rank: 0 }),
          verb({ senseId: 'v2', rank: 1, translation: 'להכיר' }),
          noun({ senseId: 'n1', rank: 0 }),
          noun({ senseId: 'n2', rank: 1, translation: 'עילית' }),
        ],
        [{ senseId: 'v2', variantId: 'v-verb' }, { senseId: 'n2', variantId: 'v-noun' }],
        [],
      );
      expect(detail.senses.map((s) => s.sense_id)).toEqual(['n2', 'v2', 'n1', 'v1']);
    });

    it("labels a saved sense with its lexeme's part of speech, not the saved form's neighbours'", () => {
      // Both lexemes have a form spelled знать; the saved noun sense must still read
      // as a noun even though the verb's sense sorts beside it.
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [verb({ senseId: 'v1' }), noun({ senseId: 'n1' })],
        [{ senseId: 'n1', variantId: 'v-noun' }],
        [],
      );
      expect(detail.senses.map((s) => [s.sense_id, s.part_of_speech, s.saved])).toEqual([
        ['n1', 'noun', true],
        ['v1', 'verb', false],
      ]);
    });

    it("averages the word's level over the saved senses of both lexemes", () => {
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [verb({ senseId: 'v1' }), noun({ senseId: 'n1' })],
        [{ senseId: 'v1', variantId: 'v-verb' }, { senseId: 'n1', variantId: 'v-noun' }],
        [...levels('v1', 5), ...levels('n1', 2)],
      );
      expect(detail.level).toBe(4);
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

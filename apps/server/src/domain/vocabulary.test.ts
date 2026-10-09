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
  firstPerGloss,
  markSaved,
  type LexemeRendering,
  type WordLexeme,
  type WordSummary,
} from './vocabulary';

describe('the cursor', () => {
  const cursorOf = (savedAt: string, lemma: string) =>
    Buffer.from(JSON.stringify(['lemma', savedAt, lemma]), 'utf8').toString('base64url');
  const raw = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const cursor = { savedAt: '2026-10-04 12:00:00.123456+00', lemma: 'знать' };

  it('round-trips, as a tagged three-element array', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(JSON.parse(Buffer.from(encodeCursor(cursor), 'base64url').toString('utf8'))).toEqual([
      'lemma',
      cursor.savedAt,
      'знать',
    ]);
  });

  it('round-trips a lemma with a space and a slash', () => {
    for (const lemma of ['всё равно', 'и/или']) {
      const c = { savedAt: '2026-10-04 12:00:00+00', lemma };
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
    }
  });

  it('accepts a leap day in a leap year and every offset form the server issues', () => {
    for (const savedAt of [
      '2028-02-29 23:59:59.999999+00',
      '2026-10-04 12:00:00.1-08',
      '2026-10-04 12:00:00+05:45',
      '2026-10-04 00:00:00-03:30',
    ]) {
      expect(decodeCursor(cursorOf(savedAt, 'kite'))).toEqual({ savedAt, lemma: 'kite' });
    }
  });

  it.each([
    ['not base64 json', '!!!'],
    ['an object', raw({ a: 1 })],
    ['a junk timestamp', cursorOf('yesterday', 'kite')],
    ['an empty lemma', cursorOf('2026-10-04 12:00:00+00', '')],
    ['a lemma that is not a string', raw(['lemma', '2026-10-04 12:00:00+00', 7])],
    ['a lemma containing NUL', cursorOf('2026-10-04 12:00:00+00', 'ki\u0000te')],
    ['a wrong tag', raw(['lexeme', '2026-10-04 12:00:00+00', 'kite'])],
    // Review Focus 3: cursors an app may hold from before this phase.
    ['a phase 18 newest cursor', raw(['2026-10-04 12:00:00+00', 'lx-1'])],
    ['a phase 20 level cursor', raw(['2026-10-04 12:00:00+00', 'lx-1', 'level_asc', 2])],
    ['a well-shaped but out-of-range timestamp', cursorOf('2026-13-45 25:61:00+00', 'kite')],
    ['a day the month does not have', cursorOf('2026-02-30 12:00:00+00', 'kite')],
    ['a leap day in a common year', cursorOf('2026-02-29 12:00:00+00', 'kite')],
    ['an hour of 24', cursorOf('2026-10-04 24:00:00+00', 'kite')],
    ['a second of 60', cursorOf('2026-10-04 12:00:60+00', 'kite')],
    ['an offset of 99 hours', cursorOf('2026-10-04 12:00:00+99', 'kite')],
    ['an offset with 75 minutes', cursorOf('2026-10-04 12:00:00+05:75', 'kite')],
  ])('refuses %s', (_label, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});

describe('cursorAfter', () => {
  it('continues after the row', () => {
    expect(cursorAfter({ lemma: 'kite', lastSavedAt: '2026-10-04 12:00:00+00', level: 2 })).toEqual({
      savedAt: '2026-10-04 12:00:00+00',
      lemma: 'kite',
    });
  });
});

const summary = (lemma: string, over: Partial<WordSummary> = {}): WordSummary => ({
  lemma,
  partsOfSpeech: ['noun'],
  headlineGlossId: `g-${lemma}`,
  headlineTranslation: `tr-${lemma}`,
  headlineForm: `form-${lemma}`,
  savedCount: 1,
  glossCount: 2,
  addedBy: [],
  ...over,
});

describe('assemblePage', () => {
  it('keeps the page order, not the summaries order', () => {
    const rows = [
      { lemma: 'b', lastSavedAt: 't2', level: 3 },
      { lemma: 'a', lastSavedAt: 't1', level: 1 },
    ];
    const page = assemblePage(rows, [summary('a'), summary('b', { partsOfSpeech: ['noun', 'verb'] })]);
    expect(page.map((w) => w.lemma)).toEqual(['b', 'a']);
    expect(page[0]).toEqual({
      lemma: 'b',
      parts_of_speech: ['noun', 'verb'],
      headline: { gloss_id: 'g-b', translation: 'tr-b', form: 'form-b' },
      saved_count: 1,
      gloss_count: 2,
      level: 3,
      added_by: [],
    });
  });

  it('carries the other adders of a word', () => {
    const rows = [{ lemma: 'a', lastSavedAt: 't1', level: 1 }];
    const page = assemblePage(rows, [summary('a', { addedBy: ['רינה'] })]);
    expect(page[0].added_by).toEqual(['רינה']);
  });

  it('drops a page row with no summary', () => {
    const rows = [
      { lemma: 'a', lastSavedAt: 't2', level: 1 },
      { lemma: 'gone', lastSavedAt: 't1', level: 1 },
    ];
    expect(assemblePage(rows, [summary('a')]).map((w) => w.lemma)).toEqual(['a']);
  });
});

const rendering = (over: Partial<LexemeRendering> & Pick<LexemeRendering, 'senseId' | 'glossId' | 'variantId' | 'form' | 'translation'>): LexemeRendering => ({
  lexemeId: 'l1',
  rank: 0,
  exampleSource: null,
  exampleTarget: null,
  glossKey: over.translation,
  glossAlternatives: [],
  ...over,
});
const NOUN: WordLexeme[] = [{ lexemeId: 'l1', partOfSpeech: 'noun' }];

describe('buildWordDetail by gloss (phase 31)', () => {
  it("makes one card of a gloss's senses, headlined by the key, with an example from each member", () => {
    const detail = buildWordDetail('mouse', NOUN, [
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v1', form: 'mouse', translation: 'עכבר', rank: 0, exampleSource: 'The mouse ran.', exampleTarget: 'העכבר רץ.' }),
      rendering({ senseId: 's2', glossId: 'g1', variantId: 'v1', form: 'mouse', translation: 'עכבר', rank: 1, exampleSource: 'Click the mouse.', exampleTarget: 'לחץ על העכבר.' }),
    ], [], []);
    expect(detail.senses).toHaveLength(1);
    expect(detail.senses[0]).toMatchObject({
      gloss_id: 'g1',
      translation: 'עכבר',
      examples: [
        { source: 'The mouse ran.', target: 'העכבר רץ.' },
        { source: 'Click the mouse.', target: 'לחץ על העכבר.' },
      ],
      saved: false,
    });
  });

  it("headlines the key, not the saved form's rendering, and says which form it was saved from", () => {
    const detail = buildWordDetail('finger', NOUN, [
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_fingers', form: 'fingers', translation: 'אצבעות', glossKey: 'אצבע', glossAlternatives: ['אצבע יד'] }),
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_finger', form: 'finger', translation: 'אצבע', glossKey: 'אצבע', glossAlternatives: ['אצבע יד'] }),
    ], [{ glossId: 'g1', variantId: 'v_fingers', addedBy: null }], []);
    expect(detail.senses[0]).toMatchObject({
      translation: 'אצבע',
      alternatives: ['אצבע יד'],
      variant_id: 'v_fingers',
      form: 'fingers',
      saved: true,
      saved_from: { form: 'fingers', translation: 'אצבעות' },
    });
  });

  it('takes a member’s example from the lemma form where it has one', () => {
    const detail = buildWordDetail('car', NOUN, [
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_cars', form: 'cars', translation: 'מכוניות', glossKey: 'מכונית', exampleSource: 'Cars pass.', exampleTarget: 'מכוניות עוברות.' }),
      rendering({ senseId: 's1', glossId: 'g1', variantId: 'v_car', form: 'car', translation: 'מכונית', exampleSource: 'A car.', exampleTarget: 'מכונית.' }),
    ], [], []);
    expect(detail.senses[0].examples).toEqual([{ source: 'A car.', target: 'מכונית.' }]);
    expect(detail.senses[0]).not.toHaveProperty('saved_from');
  });

  it('lists saved glosses first, then by part of speech, then by rank', () => {
    const detail = buildWordDetail('stream', [{ lexemeId: 'ln', partOfSpeech: 'noun' }, { lexemeId: 'lv', partOfSpeech: 'verb' }], [
      rendering({ lexemeId: 'ln', senseId: 'n1', glossId: 'g_nahal', variantId: 'vn', form: 'stream', translation: 'נחל', rank: 0 }),
      rendering({ lexemeId: 'ln', senseId: 'n2', glossId: 'g_zerem', variantId: 'vn', form: 'stream', translation: 'זרם', rank: 1 }),
      rendering({ lexemeId: 'lv', senseId: 'v1', glossId: 'g_lizrom', variantId: 'vv', form: 'stream', translation: 'לזרום', rank: 0 }),
    ], [{ glossId: 'g_lizrom', variantId: 'vv', addedBy: null }], []);
    expect(detail.senses.map((card) => card.translation)).toEqual(['לזרום', 'נחל', 'זרם']);
  });
});

// The rules phases 18 to 28 pinned per sense, which hold per gloss: the form a
// card names, the fallback, the adder, the levels, and the order across lexemes.
describe('buildWordDetail', () => {
  const LEMMA = 'прочитать';
  const VERB: WordLexeme[] = [{ lexemeId: 'l1', partOfSpeech: 'verb' }];
  /** One sense of its own gloss, `g-<sense id>`, rendered by the lemma's form
   *  unless a test names another. */
  const reading = (over: Partial<LexemeRendering> & Pick<LexemeRendering, 'senseId'>): LexemeRendering =>
    rendering({ glossId: `g-${over.senseId}`, variantId: 'v1', form: LEMMA, translation: 'לקרוא', ...over });

  it("names an unsaved gloss's rendering in the lemma's own form when one exists", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        reading({ senseId: 's1', variantId: 'v-past', form: 'прочитала', translation: 'קראה', glossKey: 'לקרוא' }),
        reading({ senseId: 's1', variantId: 'v-lemma', form: 'Прочитать' }),
      ],
      [],
      [],
    );
    expect(detail.senses[0]).toMatchObject({ variant_id: 'v-lemma', form: 'Прочитать', translation: 'לקרוא', saved: false });
  });

  it('otherwise names the form that renders the most of this lexeme, ties by variant id', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        reading({ senseId: 's1', variantId: 'v-b', form: 'прочитаю' }),
        reading({ senseId: 's2', variantId: 'v-b', form: 'прочитаю', rank: 1, translation: 'להקריא' }),
        reading({ senseId: 's1', variantId: 'v-a', form: 'прочитала' }),
        reading({ senseId: 's3', variantId: 'v-c', form: 'прочитал', rank: 2, translation: 'לסיים לקרוא' }),
        reading({ senseId: 's3', variantId: 'v-d', form: 'прочитали', rank: 2, translation: 'לסיים לקרוא' }),
      ],
      [],
      [],
    );
    const shown = Object.fromEntries(detail.senses.map((s) => [s.gloss_id, s.variant_id]));
    expect(shown).toEqual({ 'g-s1': 'v-b', 'g-s2': 'v-b', 'g-s3': 'v-c' });
  });

  // Review Focus 3 of phase 18: the saved form no longer renders the gloss.
  it('falls back to the representative rendering when the saved form no longer renders the gloss', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [reading({ senseId: 's1', variantId: 'v-lemma' })],
      [{ glossId: 'g-s1', variantId: 'v-gone', addedBy: null }],
      [],
    );
    expect(detail.senses).toEqual([expect.objectContaining({ gloss_id: 'g-s1', variant_id: 'v-lemma', saved: true })]);
    expect(detail.senses[0]).not.toHaveProperty('saved_from');
  });

  it('orders saved glosses first, each group by rank, then by gloss id', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        reading({ senseId: 's-a', rank: 0 }),
        reading({ senseId: 's-b', rank: 2, translation: 'להקריא' }),
        reading({ senseId: 's-d', rank: 1, translation: 'לקרוא בקול' }),
        reading({ senseId: 's-c', rank: 1, translation: 'לסיים לקרוא' }),
      ],
      [{ glossId: 'g-s-b', variantId: 'v1', addedBy: null }],
      [],
    );
    expect(detail.senses.map((s) => s.gloss_id)).toEqual(['g-s-b', 'g-s-a', 'g-s-c', 'g-s-d']);
  });

  it('takes only whole examples, and gives a gloss with none an empty list', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        reading({ senseId: 's1', exampleSource: 'Я прочитала книгу.', exampleTarget: 'קראתי את הספר.' }),
        reading({ senseId: 's2', rank: 1, translation: 'להקריא', exampleSource: 'half', exampleTarget: null }),
      ],
      [],
      [],
    );
    expect(detail.senses[0].examples).toEqual([{ source: 'Я прочитала книгу.', target: 'קראתי את הספר.' }]);
    expect(detail.senses[1].examples).toEqual([]);
  });

  it('names who added a saved gloss when it was not the owner', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        reading({ senseId: 's1' }),
        reading({ senseId: 's2', rank: 1, translation: 'להקריא' }),
        reading({ senseId: 's3', rank: 2, translation: 'לסיים לקרוא' }),
      ],
      [
        { glossId: 'g-s1', variantId: 'v1', addedBy: 'רינה' },
        { glossId: 'g-s2', variantId: 'v1', addedBy: null },
      ],
      [],
    );
    expect(detail.senses[0].added_by).toBe('רינה');
    expect(detail.senses[1]).not.toHaveProperty('added_by');
    expect(detail.senses[2]).not.toHaveProperty('added_by');
  });

  it('carries the lemma, and no lexeme fields', () => {
    expect(buildWordDetail(LEMMA, VERB, [], [], [])).toEqual({ lemma: LEMMA, level: null, senses: [] });
  });

  // Phases 23-25: every dimension is live, so a gloss practised evenly has
  // them all at `live`.
  const levels = (glossId: string, live: number): ProgressRow[] =>
    DIMENSIONS.map((dimension) => ({
      glossId,
      dimension,
      level: live,
      lastStepOn: null,
      lastWrongOn: null,
    }));

  it('gives a saved gloss its badge and five levels, and an unsaved one neither', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [reading({ senseId: 's1' }), reading({ senseId: 's2', rank: 1, translation: 'להקריא' })],
      [{ glossId: 'g-s1', variantId: 'v1', addedBy: null }],
      levels('g-s1', 3),
    );
    expect(detail.senses[0]).toMatchObject({
      gloss_id: 'g-s1',
      progress: {
        level: 3,
        dimensions: { written_receptive: 3, written_productive: 3, spoken_receptive: 3, spoken_productive: 3, spelling: 3 },
      },
    });
    expect(detail.senses[1]).not.toHaveProperty('progress');
  });

  // Phase 23 (spec D7): a word known only by recognition reads lower once
  // writing and spelling are live.
  it('averages the badge over all five dimensions', () => {
    const recognisedOnly = DIMENSIONS.map((dimension) => ({
      glossId: 'g-s1',
      dimension,
      level: dimension === 'written_receptive' ? 3 : 1,
      lastStepOn: null,
      lastWrongOn: null,
    }));
    const detail = buildWordDetail(LEMMA, VERB, [reading({ senseId: 's1' })], [{ glossId: 'g-s1', variantId: 'v1', addedBy: null }], recognisedOnly);
    expect(detail.senses[0].progress?.level).toBe(1);
    expect(detail.level).toBe(1);
  });

  it("gives the word one flat mean over every saved gloss's live-dimension levels, rounded once, ties up", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [reading({ senseId: 's1' }), reading({ senseId: 's2', translation: 'להקריא' })],
      [{ glossId: 'g-s1', variantId: 'v1', addedBy: null }, { glossId: 'g-s2', variantId: 'v1', addedBy: null }],
      [...levels('g-s1', 2), ...levels('g-s2', 3)],
    );
    expect(detail.level).toBe(3);
  });

  it('gives a word with nothing saved no level', () => {
    expect(buildWordDetail(LEMMA, VERB, [reading({ senseId: 's1' })], [], []).level).toBeNull();
  });

  describe('a lemma with two lexemes', () => {
    // знать: the verb (to know) and the noun (nobility). Ids chosen so that gloss
    // id order and part-of-speech order disagree, which the ordering must survive.
    const ZNAT: WordLexeme[] = [
      { lexemeId: 'lx-noun', partOfSpeech: 'noun' },
      { lexemeId: 'lx-verb', partOfSpeech: 'verb' },
    ];
    const verb = (over: Partial<LexemeRendering> & Pick<LexemeRendering, 'senseId'>) =>
      reading({ lexemeId: 'lx-verb', variantId: 'v-verb', form: 'знать', translation: 'לדעת', ...over });
    const noun = (over: Partial<LexemeRendering> & Pick<LexemeRendering, 'senseId'>) =>
      reading({ lexemeId: 'lx-noun', variantId: 'v-noun', form: 'знать', translation: 'אצולה', ...over });

    it('shows every gloss of both, each with its own part of speech', () => {
      const detail = buildWordDetail('знать', ZNAT, [verb({ senseId: 'a-know' }), noun({ senseId: 'z-nobility' })], [], []);
      expect(detail.senses.map((s) => [s.gloss_id, s.part_of_speech])).toEqual([
        ['g-z-nobility', 'noun'],
        ['g-a-know', 'verb'],
      ]);
    });

    it('orders saved first, then by part of speech, then by rank, then by gloss id', () => {
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [
          verb({ senseId: 'v1', rank: 0 }),
          verb({ senseId: 'v2', rank: 1, translation: 'להכיר' }),
          noun({ senseId: 'n1', rank: 0 }),
          noun({ senseId: 'n2', rank: 1, translation: 'עילית' }),
        ],
        [{ glossId: 'g-v2', variantId: 'v-verb', addedBy: null }, { glossId: 'g-n2', variantId: 'v-noun', addedBy: null }],
        [],
      );
      expect(detail.senses.map((s) => s.gloss_id)).toEqual(['g-n2', 'g-v2', 'g-n1', 'g-v1']);
    });

    it("labels a saved gloss with its lexeme's part of speech, not the saved form's neighbours'", () => {
      // Both lexemes have a form spelled знать; the saved noun gloss must still read
      // as a noun even though the verb's gloss sorts beside it.
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [verb({ senseId: 'v1' }), noun({ senseId: 'n1' })],
        [{ glossId: 'g-n1', variantId: 'v-noun', addedBy: null }],
        [],
      );
      expect(detail.senses.map((s) => [s.gloss_id, s.part_of_speech, s.saved])).toEqual([
        ['g-n1', 'noun', true],
        ['g-v1', 'verb', false],
      ]);
    });

    it("averages the word's level over the saved glosses of both lexemes", () => {
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [verb({ senseId: 'v1' }), noun({ senseId: 'n1' })],
        [{ glossId: 'g-v1', variantId: 'v-verb', addedBy: null }, { glossId: 'g-n1', variantId: 'v-noun', addedBy: null }],
        [...levels('g-v1', 5), ...levels('g-n1', 2)],
      );
      expect(detail.level).toBe(4);
    });
  });
});

describe('markSaved', () => {
  it('marks senses with ids and leaves a sense without ids alone', () => {
    const marked = markSaved(
      [
        { translation: 'a', gloss_id: 'g-s1', variant_id: 'v1' },
        { translation: 'b', gloss_id: 'g-s2', variant_id: 'v1' },
        { translation: 'sentence' },
      ],
      new Set(['g-s2']),
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

describe('firstPerGloss', () => {
  // Review Focus 1: a double-tapped save-all sends a gloss twice.
  it('keeps the first entry of each gloss, in order', () => {
    expect(
      firstPerGloss([
        { gloss_id: 'g-s1', variant_id: 'v1' },
        { gloss_id: 'g-s2', variant_id: 'v1' },
        { gloss_id: 'g-s1', variant_id: 'v2' },
      ]),
    ).toEqual([
      { gloss_id: 'g-s1', variant_id: 'v1' },
      { gloss_id: 'g-s2', variant_id: 'v1' },
    ]);
  });
});

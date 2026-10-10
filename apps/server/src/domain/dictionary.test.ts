import { describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';

import {
  entriesToRows,
  flattenEntries,
  kindForForm,
  mergeEntries,
  normalizeForm,
  renderingOf,
  rowsToCards,
  staleLexemes,
} from './dictionary';
import type { SenseRow, StaleLexemeRow } from './dictionary';

const sense = (translation: string, sense_code: string): LlmEntry['senses'][number] => ({
  translation,
  sense_code,
});

describe('mergeEntries', () => {
  it('leaves distinct lemmas alone, in order', () => {
    const entries: LlmEntry[] = [
      { lemma: 'see', part_of_speech: 'verb', senses: [sense('לראות', 'perceive')] },
      { lemma: 'saw', part_of_speech: 'noun', senses: [sense('מסור', 'tool')] },
    ];
    expect(mergeEntries(entries)).toEqual(entries);
  });

  it('concatenates same-lexeme entries in order, because the write cannot', () => {
    // Dictionaries publish `book` as book:1 and book:2, so a model may well
    // split one lexeme across two entries. Under
    // UNIQUE(language_code, lemma, part_of_speech) the second would silently
    // lose its senses. Note both entries here are the NOUN: a noun and a verb
    // are two lexemes and must stay apart — that is the case below this one.
    const merged = mergeEntries([
      { lemma: 'book', part_of_speech: 'noun', senses: [sense('ספר', 'printed_book')] },
      { lemma: 'book', part_of_speech: 'noun', senses: [sense('כרך', 'volume')] },
    ]);
    expect(merged).toEqual([
      {
        lemma: 'book',
        part_of_speech: 'noun',
        senses: [sense('ספר', 'printed_book'), sense('כרך', 'volume')],
      },
    ]);
  });

  it('does not mutate the entries it was given', () => {
    const first: LlmEntry = {
      lemma: 'book',
      part_of_speech: 'noun',
      senses: [sense('ספר', 'printed_book')],
    };
    mergeEntries([
      first,
      { lemma: 'book', part_of_speech: 'noun', senses: [sense('כרך', 'volume')] },
    ]);
    expect(first.senses).toHaveLength(1);
  });

  it('handles an empty list', () => {
    expect(mergeEntries([])).toEqual([]);
  });
});

describe('flattenEntries', () => {
  it('interleaves by rank rather than by entry, so no headword is crowded out', () => {
    const flat = flattenEntries(
      [
        {
          lemma: 'see',
          part_of_speech: 'verb',
          senses: [sense('לראות', 'a'), sense('להבין', 'b'), sense('לפגוש', 'c')],
        },
        { lemma: 'saw', part_of_speech: 'noun', senses: [sense('מסור', 'd'), sense('לנסר', 'e')] },
      ],
      'word',
    );
    expect(flat.map((s) => s.translation)).toEqual([
      'לראות',
      'מסור',
      'להבין',
      'לנסר',
      'לפגוש',
    ]);
  });

  it('caps the flattened list at five', () => {
    const flat = flattenEntries(
      [
        { lemma: 'a', part_of_speech: 'noun', senses: [1, 2, 3, 4].map((n) => sense(`a${n}`, `a${n}`)) },
        { lemma: 'b', part_of_speech: 'noun', senses: [1, 2, 3, 4].map((n) => sense(`b${n}`, `b${n}`)) },
      ],
      'word',
    );
    expect(flat).toHaveLength(5);
    expect(flat.map((s) => s.translation)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('never emits sense_code, which must not reach a client', () => {
    const flat = flattenEntries(
      [{ lemma: 'book', part_of_speech: 'noun', senses: [sense('ספר', 'printed_book')] }],
      'word',
    );
    expect(flat[0]).toEqual({ translation: 'ספר', part_of_speech: 'noun' });
    expect(flat[0]).not.toHaveProperty('sense_code');
  });

  it('carries the entry part of speech and a complete example through', () => {
    const flat = flattenEntries(
      [
        {
          lemma: 'book',
          part_of_speech: 'noun',
          senses: [
            {
              translation: 'ספר',
              example: { source: 'I read a book.', target: 'קראתי ספר.' },
              sense_code: 'printed_book',
            },
          ],
        },
      ],
      'word',
    );
    expect(flat[0]).toEqual({
      translation: 'ספר',
      part_of_speech: 'noun',
      examples: [{ source: 'I read a book.', target: 'קראתי ספר.' }],
    });
  });

  it('handles an empty list', () => {
    expect(flattenEntries([], 'word')).toEqual([]);
  });
});

describe('normalizeForm', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeForm('  good   morning ')).toBe('good morning');
    expect(normalizeForm('book')).toBe('book');
  });

  it('leaves casing alone — lower(form) in the index handles matching', () => {
    expect(normalizeForm('BOOK')).toBe('BOOK');
    expect(normalizeForm('How do you do?')).toBe('How do you do?');
  });

  it('leaves nikud alone — it is part of the word, not punctuation around it', () => {
    expect(normalizeForm('שָׁלוֹם')).toBe('שָׁלוֹם');
  });

  // Phase 12 follow-up. `normalizeForm` is what turns a typed string into a dictionary
  // KEY, and it used to collapse whitespace and nothing else — so `book?` was a
  // different key from `book`, looked up separately, paid for separately and
  // stored forever alongside it. The dev database held exactly that: `book` with
  // three senses and `book?` with four, divergent copies of one word.
  it('strips trailing punctuation from a single word, which is a key and not a sentence', () => {
    expect(normalizeForm('book?')).toBe('book');
    expect(normalizeForm('booked.')).toBe('booked');
    expect(normalizeForm('book!!!')).toBe('book');
  });

  it('strips it in either script — the same key collision exists in Hebrew', () => {
    expect(normalizeForm('שלום!')).toBe('שלום');
  });

  // The narrow rule, and why it is narrow: punctuation is part of a multi-word
  // expression, and two of the seeded ones carry it. Stripping here would split
  // every recorded phrase away from its own seed row.
  it('leaves a multi-word expression its punctuation', () => {
    expect(normalizeForm('How do you do?')).toBe('How do you do?');
    expect(normalizeForm('Have a nice day!')).toBe('Have a nice day!');
  });

  // Stripping to nothing would hand the lookup an empty form, which the request
  // schema's min(1) had already rejected on the way in.
  it('never strips a form away to nothing', () => {
    expect(normalizeForm('?!')).toBe('?!');
  });

  it('collapses a tab and a newline the same way as a space', () => {
    expect(normalizeForm('see\tyou\nlater')).toBe('see you later');
  });
});

describe('entriesToRows', () => {
  it('numbers entries by their order and senses 0..n within an entry', () => {
    const rows = entriesToRows([
      {
        lemma: 'see',
        part_of_speech: 'verb',
        senses: [
          { translation: 'לראות', sense_code: 'perceive' },
          { translation: 'להבין', sense_code: 'understand' },
        ],
      },
      { lemma: 'saw', part_of_speech: 'noun', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
    ]);

    expect(rows.map((row) => [row.lemma, row.entryRank])).toEqual([
      ['see', 0],
      ['saw', 1],
    ]);
    expect(rows[0].senses.map((sense) => sense.rank)).toEqual([0, 1]);
    expect(rows[1].senses.map((sense) => sense.rank)).toEqual([0]);
  });

  it('splits the example by what each half depends on, and nulls what is absent', () => {
    const [row] = entriesToRows([
      {
        lemma: 'book',
        part_of_speech: 'noun',
        senses: [
          {
            translation: 'ספר',
            example: { source: 'I read a book.', target: 'קראתי ספר.' },
            sense_code: 'printed_book',
          },
          { translation: 'כרך', sense_code: 'volume' },
        ],
      },
    ]);

    // Both example halves on the sense row, and no part of speech: that is on
    // the entry row now, because it belongs to the lexeme rather than a meaning.
    expect(row.partOfSpeech).toBe('noun');
    expect(row.senses[0]).toEqual({
      rank: 0,
      senseCode: 'printed_book',
      translation: 'ספר',
      alternatives: [],
      gloss: 'ספר',
      glossAlternatives: [],
      definition: null,
      exampleSource: 'I read a book.',
      exampleTarget: 'קראתי ספר.',
    });
    expect(row.senses[1]).toEqual({
      rank: 1,
      senseCode: 'volume',
      translation: 'כרך',
      alternatives: [],
      gloss: 'כרך',
      glossAlternatives: [],
      definition: null,
      exampleSource: null,
      exampleTarget: null,
    });
  });
});

const row = (over: Partial<SenseRow> & Pick<SenseRow, 'senseId' | 'glossId' | 'translation' | 'rank'>): SenseRow => ({
  lexemeId: 'l1',
  variantId: 'v1',
  entryRank: 0,
  partOfSpeech: 'noun',
  exampleSource: null,
  exampleTarget: null,
  kind: 'word',
  glossKey: over.translation,
  alternatives: [],
  ...over,
});

describe('rowsToCards (phase 31, spec D10, D15)', () => {
  it('makes one card of two senses with one target word, with an example from each', () => {
    const cards = rowsToCards([
      row({ senseId: 's1', glossId: 'g1', translation: 'עכבר', rank: 0, exampleSource: 'The mouse ran.', exampleTarget: 'העכבר רץ.' }),
      row({ senseId: 's2', glossId: 'g1', translation: 'עכבר', rank: 1, exampleSource: 'Click the mouse.', exampleTarget: 'לחץ על העכבר.' }),
    ]);
    expect(cards).toEqual([
      {
        translation: 'עכבר',
        part_of_speech: 'noun',
        gloss_id: 'g1',
        variant_id: 'v1',
        examples: [
          { source: 'The mouse ran.', target: 'העכבר רץ.' },
          { source: 'Click the mouse.', target: 'לחץ על העכבר.' },
        ],
      },
    ]);
  });

  it("groups lane 0's seven `stream` rows into five cards, so no gloss hides behind a row cap", () => {
    const noun = { lexemeId: 'l_noun', entryRank: 0, partOfSpeech: 'noun' };
    const verb = { lexemeId: 'l_verb', entryRank: 1, partOfSpeech: 'verb', variantId: 'v2' };
    const cards = rowsToCards([
      row({ ...noun, senseId: 'n1', glossId: 'g_nahal', translation: 'נחל', rank: 0 }),
      row({ ...verb, senseId: 'v1', glossId: 'g_lizrom', translation: 'לזרום', rank: 0 }),
      row({ ...noun, senseId: 'n2', glossId: 'g_zerem', translation: 'זרם', rank: 1 }),
      row({ ...verb, senseId: 'v2', glossId: 'g_lizrom', translation: 'לזרום', rank: 1 }),
      row({ ...noun, senseId: 'n3', glossId: 'g_zerem', translation: 'זרם', rank: 2 }),
      row({ ...verb, senseId: 'v3', glossId: 'g_streaming', translation: 'לשדר בסטרימינג', rank: 2 }),
      row({ ...noun, senseId: 'n4', glossId: 'g_stream_n', translation: 'סטרימינג', rank: 3 }),
    ]);
    expect(cards.map((card) => card.translation)).toEqual(['נחל', 'לזרום', 'זרם', 'לשדר בסטרימינג', 'סטרימינג']);
  });

  it("sends the gloss's key only when the typed form says something else", () => {
    const [plural] = rowsToCards([row({ senseId: 's1', glossId: 'g1', translation: 'אצבעות', glossKey: 'אצבע', rank: 0 })]);
    const [vowelled] = rowsToCards([row({ senseId: 's1', glossId: 'g1', translation: 'עכבר', glossKey: 'עַכְבָּר', rank: 0 })]);
    expect(plural.key).toBe('אצבע');
    expect(vowelled.key).toBeUndefined();
  });

  it("pools the members' alternatives, never the translation, never twice", () => {
    const [card] = rowsToCards([
      row({ senseId: 's1', glossId: 'g1', translation: 'מכוניות', rank: 0, alternatives: ['רכבים'] }),
      row({ senseId: 's2', glossId: 'g1', translation: 'מכוניות', rank: 1, alternatives: ['רכבים', 'אוטואים', 'מכוניות'] }),
    ]);
    expect(card.alternatives).toEqual(['רכבים', 'אוטואים']);
  });

  it('stops at five cards', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ senseId: `s${i}`, glossId: `g${i}`, translation: `מילה${i}`, rank: i }));
    expect(rowsToCards(rows)).toHaveLength(5);
  });

  // The cap stops new cards, not the rows of a card already started: the read
  // sorts by rank across headwords, so a member of the first card can arrive
  // after a sixth gloss's row has been turned away.
  it("still gathers a started card's later member after the sixth gloss is turned away", () => {
    const cards = rowsToCards([
      row({ senseId: 's0', glossId: 'g0', translation: 'עכבר', rank: 0, exampleSource: 'The mouse ran.', exampleTarget: 'העכבר רץ.', alternatives: ['מכרסם'] }),
      ...[1, 2, 3, 4, 5].map((i) => row({ senseId: `s${i}`, glossId: `g${i}`, translation: `מילה${i}`, rank: 0, entryRank: i })),
      row({ senseId: 's6', glossId: 'g0', translation: 'עכבר', rank: 1, exampleSource: 'Click the mouse.', exampleTarget: 'לחץ על העכבר.', alternatives: ['עכברון'] }),
    ]);
    expect(cards.map((card) => card.gloss_id)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']);
    expect(cards[0]).toMatchObject({
      examples: [
        { source: 'The mouse ran.', target: 'העכבר רץ.' },
        { source: 'Click the mouse.', target: 'לחץ על העכבר.' },
      ],
      alternatives: ['מכרסם', 'עכברון'],
    });
  });
});

// The per-field rules rowsToSenses held before phase 31, kept for the cards.
describe('rowsToCards, field by field', () => {
  const one = (over: Partial<SenseRow> = {}) =>
    rowsToCards([row({ senseId: 's1', glossId: 'g1', translation: 'לראות', rank: 0, ...over })])[0];

  it('keeps the order it was handed — the read already sorted it', () => {
    const cards = rowsToCards([
      row({ senseId: 's1', glossId: 'g1', translation: 'לראות', rank: 0 }),
      row({ senseId: 's2', glossId: 'g2', translation: 'מסור', rank: 0 }),
    ]);
    expect(cards.map((card) => card.translation)).toEqual(['לראות', 'מסור']);
  });

  it('builds an example only when both halves are present', () => {
    expect(one({ exampleSource: 'I see.', exampleTarget: 'אני רואה.' }).examples).toEqual([
      { source: 'I see.', target: 'אני רואה.' },
    ]);
    expect(one({ exampleSource: 'I see.' })).not.toHaveProperty('examples');
    expect(one({ exampleTarget: 'אני רואה.' })).not.toHaveProperty('examples');
  });

  it('omits an absent part of speech rather than emitting null', () => {
    expect(one({ partOfSpeech: null })).toEqual({ translation: 'לראות', gloss_id: 'g1', variant_id: 'v1' });
    expect(one({ partOfSpeech: 'verb' }).part_of_speech).toBe('verb');
  });

  it('emits ids, never sense_code or any other row-only field', () => {
    const card = one({
      translation: 'מכוניות',
      glossKey: 'מכונית',
      alternatives: ['רכבים'],
      exampleSource: 'Cars pass.',
      exampleTarget: 'מכוניות עוברות.',
    });
    expect(Object.keys(card).sort()).toEqual([
      'alternatives',
      'examples',
      'gloss_id',
      'key',
      'part_of_speech',
      'translation',
      'variant_id',
    ]);
  });
});

describe('flattenEntries (phase 31)', () => {
  it("groups one entry's senses by citation form, as the written path will", () => {
    const cards = flattenEntries(
      [
        {
          lemma: 'mouse',
          part_of_speech: 'noun',
          senses: [
            { translation: 'עכבר', sense_code: 'rodent', example: { source: 'A mouse.', target: 'עכבר.' } },
            { translation: 'עכבר', sense_code: 'device', example: { source: 'Click it.', target: 'לחץ.' } },
          ],
        },
      ],
      'word',
    );
    expect(cards).toEqual([
      {
        translation: 'עכבר',
        part_of_speech: 'noun',
        examples: [
          { source: 'A mouse.', target: 'עכבר.' },
          { source: 'Click it.', target: 'לחץ.' },
        ],
      },
    ]);
  });

  // Spec D4's one translation is a word sense's. A sentence is one translation
  // already: its comma is part of it, and cutting there answered half of it.
  it("never splits a sentence's translation", () => {
    const [card] = flattenEntries(
      [
        {
          lemma: 'I want to go home, but it is already late',
          part_of_speech: 'verb',
          senses: [{ translation: 'אני רוצה ללכת הביתה, אבל כבר מאוחר.', sense_code: 'the_sentence' }],
        },
      ],
      'sentence',
    );
    expect(card.translation).toBe('אני רוצה ללכת הביתה, אבל כבר מאוחר.');
    expect(card).not.toHaveProperty('alternatives');
  });

  it("still splits a phrase's list: the rest are its alternatives", () => {
    const [card] = flattenEntries(
      [{ lemma: 'pick up', part_of_speech: 'verb', senses: [{ translation: 'לקלוט, ללמוד', sense_code: 'learn' }] }],
      'phrase',
    );
    expect(card).toMatchObject({ translation: 'לקלוט', alternatives: ['ללמוד'] });
  });
});

describe('kindForForm', () => {
  const row = (over: Partial<SenseRow>): SenseRow => ({
    lexemeId: 't-see',
    senseId: 's-1',
    glossId: 'g-s-1',
    variantId: 'v-1',
    rank: 0,
    entryRank: 0,
    partOfSpeech: null,
    exampleSource: null,
    translation: 'לראות',
    exampleTarget: null,
    kind: 'word',
    glossKey: 'לראות',
    alternatives: [],
    ...over,
  });

  it("reads the entry_rank 0 row's kind, not the first row's", () => {
    // saw (entry_rank 1, phrase) merged ahead of see (entry_rank 0, word) —
    // exactly the round-robin order `findSensesByForm` can produce.
    const rows = [
      row({ lexemeId: 't-saw', entryRank: 1, kind: 'phrase', translation: 'מסור' }),
      row({ lexemeId: 't-see', entryRank: 0, kind: 'word', translation: 'לראות' }),
    ];

    expect(kindForForm(rows)).toBe('word');
  });

  it('is not fooled by a multi-word phrase reported as a word, or vice versa', () => {
    // The whole point of storing `kind` rather than re-deriving it from
    // whitespace: a two-word idiom the model called a `word`, honoured as
    // written rather than overridden by guesswork on the read side.
    expect(kindForForm([row({ kind: 'phrase' })])).toBe('phrase');
    expect(kindForForm([row({ kind: 'word' })])).toBe('word');
  });
});

// Phase 12: a lexeme is a lemma AND a part of speech. part_of_speech moved from
// the sense up to the entry, and both halves of the example moved down onto the
// sense row, because both land on the per-variant translation.
describe('a lexeme is a lemma and a part of speech', () => {
  const s = (code: string, translation: string) => ({ sense_code: code, translation });

  it('keeps two parts of speech of one lemma apart', () => {
    const merged = mergeEntries([
      { lemma: 'book', part_of_speech: 'noun', senses: [s('printed_work', 'N1')] },
      { lemma: 'book', part_of_speech: 'verb', senses: [s('make_reservation', 'V1')] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.part_of_speech)).toEqual(['noun', 'verb']);
  });

  it('still fuses two entries sharing a lemma AND a part of speech', () => {
    const merged = mergeEntries([
      { lemma: 'book', part_of_speech: 'noun', senses: [s('printed_work', 'N1')] },
      { lemma: 'book', part_of_speech: 'noun', senses: [s('volume', 'N2')] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].senses).toHaveLength(2);
  });

  it('puts the part of speech on the entry row and both example halves on the sense row', () => {
    const [row] = entriesToRows([
      {
        lemma: 'book',
        part_of_speech: 'verb',
        senses: [
          {
            sense_code: 'make_reservation',
            translation: 'V1',
            example: { source: 'I booked a table.', target: 'T' },
          },
        ],
      },
    ]);
    expect(row.partOfSpeech).toBe('verb');
    expect(row.senses[0]).not.toHaveProperty('partOfSpeech');
    expect(row.senses[0].exampleSource).toBe('I booked a table.');
    expect(row.senses[0].exampleTarget).toBe('T');
  });

  it('copies the entry part of speech onto every flattened sense', () => {
    const flat = flattenEntries(
      [
        { lemma: 'book', part_of_speech: 'noun', senses: [s('printed_work', 'N1')] },
        { lemma: 'book', part_of_speech: 'verb', senses: [s('make_reservation', 'V1')] },
      ],
      'word',
    );
    expect(flat.map((x) => x.part_of_speech)).toEqual(['noun', 'verb']);
  });
});

describe('staleLexemes', () => {
  const row = (over: Partial<StaleLexemeRow>): StaleLexemeRow => ({
    lexemeId: 'L1', variantId: 'V1', lemma: 'book', partOfSpeech: 'noun',
    senseVersion: 1, renderedSenseVersion: 1, ...over,
  });

  it('reports nothing when every lexeme is level', () => {
    expect(staleLexemes([row({}), row({ lexemeId: 'L2', variantId: 'V2' })])).toEqual([]);
  });

  it('reports only the lexeme that is behind', () => {
    const stale = staleLexemes([
      row({}),
      row({ lexemeId: 'L2', variantId: 'V2', partOfSpeech: 'verb', senseVersion: 3, renderedSenseVersion: 2 }),
    ]);
    expect(stale).toEqual([{ lexemeId: 'L2', variantId: 'V2', lemma: 'book', partOfSpeech: 'verb' }]);
  });

  // A form that legitimately declined a sense is level, not behind: the
  // reconciliation call answered `translation: null` and the variant's version
  // was still set to the lexeme's. Counting translations would get this wrong.
  it('does not report a form that rendered fewer senses than its lexeme holds', () => {
    expect(staleLexemes([row({ senseVersion: 4, renderedSenseVersion: 4 })])).toEqual([]);
  });
});

describe('normalizeForm and Russian stress', () => {
  it('strips a stress mark so both spellings are one key', () => {
    expect(normalizeForm('молоко́')).toBe('молоко');
    expect(normalizeForm('доро́га до́ма')).toBe('дорога дома');
  });

  it('keeps ё', () => {
    expect(normalizeForm('ёлка')).toBe('ёлка');
  });

  it('still strips trailing punctuation after stripping stress', () => {
    expect(normalizeForm('молоко́?')).toBe('молоко');
  });
});

describe('normalizeForm and Italian accents', () => {
  it('keeps an accent: it is spelling, and e and è are two words', () => {
    expect(normalizeForm('perché')).toBe('perché');
    expect(normalizeForm('città')).toBe('città');
    expect(normalizeForm('è')).toBe('è');
  });

  it('strips trailing punctuation without touching the accent', () => {
    expect(normalizeForm('perché?')).toBe('perché');
  });
});

describe('mergeEntries and Russian stress', () => {
  it('strips stress from a lemma, so a stray mark cannot make a second lexeme', () => {
    const merged = mergeEntries([
      { lemma: 'молоко́', part_of_speech: 'noun', senses: [{ sense_code: 'milk', translation: 'חלב' }] },
      { lemma: 'молоко', part_of_speech: 'noun', senses: [{ sense_code: 'milk_2', translation: 'חלב' }] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].lemma).toBe('молоко');
    expect(merged[0].senses).toHaveLength(2);
  });
});

describe('entriesToRows (phase 31)', () => {
  it('writes one clean translation and keeps the rest of a list as alternatives', () => {
    const [row] = entriesToRows([
      {
        lemma: 'combination',
        part_of_speech: 'noun',
        senses: [
          { translation: 'קומבינציה, צירוף', sense_code: 'lock_code' },
          { translation: 'שילוב (של דברים)', sense_code: 'mixture' },
        ],
      },
    ]);
    expect(row.senses.map(({ translation, alternatives, gloss }) => ({ translation, alternatives, gloss }))).toEqual([
      { translation: 'קומבינציה', alternatives: ['צירוף'], gloss: 'קומבינציה' },
      { translation: 'שילוב', alternatives: [], gloss: 'שילוב' },
    ]);
  });

  it("takes the model's citation form, alternatives and definition, tidied", () => {
    const [row] = entriesToRows([
      {
        lemma: 'car',
        part_of_speech: 'noun',
        senses: [
          {
            translation: 'מכוניות',
            sense_code: 'motor_vehicle',
            alternatives: ['רכבים', 'מכוניות', 'אוטואים'],
            gloss: 'מכונית',
            gloss_alternatives: ['רכב', 'אוטו', 'מכונית'],
            definition: '  a road vehicle with an engine ',
          },
        ],
      },
    ]);
    expect(row.senses[0]).toMatchObject({
      translation: 'מכוניות',
      alternatives: ['רכבים', 'אוטואים'],
      gloss: 'מכונית',
      glossAlternatives: ['רכב', 'אוטו'],
      definition: 'a road vehicle with an engine',
    });
  });

  it('cleans a citation form the model gave as a list, keeping the rest as citation alternatives', () => {
    const [row] = entriesToRows([
      { lemma: 'car', part_of_speech: 'noun', senses: [{ translation: 'מכונית', sense_code: 'v', gloss: 'מכונית, רכב' }] },
    ]);
    expect(row.senses[0]).toMatchObject({ gloss: 'מכונית', glossAlternatives: ['רכב'] });
  });
});

// A citation form that normalises to nothing would key a gloss by '', which
// every other such sense of the headword then joins, and head its card with
// nothing: the translation stands in for it.
describe('renderingOf, a citation form that normalises to nothing (phase 31)', () => {
  it.each([
    ['a hyphen', '-'],
    ['a bare parenthetical', '(צורת יסוד)'],
    ['blank text', '   '],
    ['a maqaf and vowel points', '־ְ'],
  ])('takes the translation for %s', (_, gloss) => {
    expect(renderingOf({ translation: 'אצבעות, בהונות', gloss }, 0)).toMatchObject({
      translation: 'אצבעות',
      gloss: 'אצבעות',
      glossAlternatives: [],
    });
  });

  it("keeps the model's citation alternatives, minus the translation that stands in", () => {
    expect(renderingOf({ translation: 'מכונית', gloss: '-', gloss_alternatives: ['רכב', 'מכונית'] }, 0)).toMatchObject({
      gloss: 'מכונית',
      glossAlternatives: ['רכב'],
    });
  });
});

import { describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';

import {
  entriesToRows,
  flattenEntries,
  kindForForm,
  languagesFor,
  mergeEntries,
  normalizeForm,
  rowsToSenses,
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
    const flat = flattenEntries([
      {
        lemma: 'see',
        part_of_speech: 'verb',
        senses: [sense('לראות', 'a'), sense('להבין', 'b'), sense('לפגוש', 'c')],
      },
      { lemma: 'saw', part_of_speech: 'noun', senses: [sense('מסור', 'd'), sense('לנסר', 'e')] },
    ]);
    expect(flat.map((s) => s.translation)).toEqual([
      'לראות',
      'מסור',
      'להבין',
      'לנסר',
      'לפגוש',
    ]);
  });

  it('caps the flattened list at five', () => {
    const flat = flattenEntries([
      { lemma: 'a', part_of_speech: 'noun', senses: [1, 2, 3, 4].map((n) => sense(`a${n}`, `a${n}`)) },
      { lemma: 'b', part_of_speech: 'noun', senses: [1, 2, 3, 4].map((n) => sense(`b${n}`, `b${n}`)) },
    ]);
    expect(flat).toHaveLength(5);
    expect(flat.map((s) => s.translation)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('never emits sense_code, which must not reach a client', () => {
    const flat = flattenEntries([
      { lemma: 'book', part_of_speech: 'noun', senses: [sense('ספר', 'printed_book')] },
    ]);
    expect(flat[0]).toEqual({ translation: 'ספר', part_of_speech: 'noun' });
    expect(flat[0]).not.toHaveProperty('sense_code');
  });

  it('carries the entry part of speech and a complete example through', () => {
    const flat = flattenEntries([
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
    ]);
    expect(flat[0]).toEqual({
      translation: 'ספר',
      part_of_speech: 'noun',
      example: { source: 'I read a book.', target: 'קראתי ספר.' },
    });
  });

  it('handles an empty list', () => {
    expect(flattenEntries([])).toEqual([]);
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

describe('languagesFor', () => {
  it('reads an English term with Hebrew translations, and the mirror', () => {
    expect(languagesFor('en_he')).toEqual({ source: 'en', target: 'he' });
    expect(languagesFor('he_en')).toEqual({ source: 'he', target: 'en' });
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
      exampleSource: 'I read a book.',
      exampleTarget: 'קראתי ספר.',
    });
    expect(row.senses[1]).toEqual({
      rank: 1,
      senseCode: 'volume',
      translation: 'כרך',
      exampleSource: null,
      exampleTarget: null,
    });
  });
});

describe('rowsToSenses', () => {
  const row = (over: Partial<SenseRow>): SenseRow => ({
    lexemeId: 't-see',
    rank: 0,
    entryRank: 0,
    partOfSpeech: null,
    exampleSource: null,
    translation: 'לראות',
    exampleTarget: null,
    kind: 'word',
    ...over,
  });

  it('keeps the order it was handed — the read already sorted it', () => {
    const senses = rowsToSenses([row({ translation: 'לראות' }), row({ translation: 'מסור' })]);
    expect(senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור']);
  });

  it('builds example only when both halves are present', () => {
    expect(
      rowsToSenses([row({ exampleSource: 'I see.', exampleTarget: 'אני רואה.' })])[0].example,
    ).toEqual({ source: 'I see.', target: 'אני רואה.' });
    expect(rowsToSenses([row({ exampleSource: 'I see.' })])[0]).not.toHaveProperty('example');
    expect(rowsToSenses([row({ exampleTarget: 'אני רואה.' })])[0]).not.toHaveProperty('example');
  });

  it('omits an absent part of speech rather than emitting null', () => {
    expect(rowsToSenses([row({})])[0]).toEqual({ translation: 'לראות' });
    expect(rowsToSenses([row({ partOfSpeech: 'verb' })])[0].part_of_speech).toBe('verb');
  });

  it('never emits sense_code or any row-only field', () => {
    const [sense] = rowsToSenses([row({ partOfSpeech: 'verb' })]);
    expect(Object.keys(sense).sort()).toEqual(['part_of_speech', 'translation']);
  });
});

describe('kindForForm', () => {
  const row = (over: Partial<SenseRow>): SenseRow => ({
    lexemeId: 't-see',
    rank: 0,
    entryRank: 0,
    partOfSpeech: null,
    exampleSource: null,
    translation: 'לראות',
    exampleTarget: null,
    kind: 'word',
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
    const flat = flattenEntries([
      { lemma: 'book', part_of_speech: 'noun', senses: [s('printed_work', 'N1')] },
      { lemma: 'book', part_of_speech: 'verb', senses: [s('make_reservation', 'V1')] },
    ]);
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

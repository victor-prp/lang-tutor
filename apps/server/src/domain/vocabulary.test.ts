import { describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';

import {
  entriesToRows,
  flattenEntries,
  languagesFor,
  mergeEntries,
  normalizeForm,
  rowsToSenses,
} from './vocabulary';
import type { SenseRow } from './vocabulary';

const sense = (translation: string, sense_code: string): LlmEntry['senses'][number] => ({
  translation,
  sense_code,
});

describe('mergeEntries', () => {
  it('leaves distinct lemmas alone, in order', () => {
    const entries: LlmEntry[] = [
      { lemma: 'see', senses: [sense('לראות', 'perceive')] },
      { lemma: 'saw', senses: [sense('מסור', 'tool')] },
    ];
    expect(mergeEntries(entries)).toEqual(entries);
  });

  it('concatenates same-lemma entries in order, because the write cannot', () => {
    // Dictionaries publish `book` as book:1 and book:2, so a model may well
    // split by part of speech. Under UNIQUE(language_code, lemma) the second
    // entry would silently lose its senses.
    const merged = mergeEntries([
      { lemma: 'book', senses: [sense('ספר', 'printed_book')] },
      { lemma: 'book', senses: [sense('להזמין', 'reserve')] },
    ]);
    expect(merged).toEqual([
      {
        lemma: 'book',
        senses: [sense('ספר', 'printed_book'), sense('להזמין', 'reserve')],
      },
    ]);
  });

  it('does not mutate the entries it was given', () => {
    const first: LlmEntry = { lemma: 'book', senses: [sense('ספר', 'printed_book')] };
    mergeEntries([first, { lemma: 'book', senses: [sense('להזמין', 'reserve')] }]);
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
        senses: [sense('לראות', 'a'), sense('להבין', 'b'), sense('לפגוש', 'c')],
      },
      { lemma: 'saw', senses: [sense('מסור', 'd'), sense('לנסר', 'e')] },
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
      { lemma: 'a', senses: [1, 2, 3, 4].map((n) => sense(`a${n}`, `a${n}`)) },
      { lemma: 'b', senses: [1, 2, 3, 4].map((n) => sense(`b${n}`, `b${n}`)) },
    ]);
    expect(flat).toHaveLength(5);
    expect(flat.map((s) => s.translation)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('never emits sense_code, which must not reach a client', () => {
    const flat = flattenEntries([{ lemma: 'book', senses: [sense('ספר', 'printed_book')] }]);
    expect(flat[0]).toEqual({ translation: 'ספר' });
    expect(flat[0]).not.toHaveProperty('sense_code');
  });

  it('carries a part of speech and a complete example through', () => {
    const flat = flattenEntries([
      {
        lemma: 'book',
        senses: [
          {
            translation: 'ספר',
            part_of_speech: 'noun',
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

  it('leaves a Hebrew string untouched, nikud and punctuation included', () => {
    expect(normalizeForm('שָׁלוֹם!')).toBe('שָׁלוֹם!');
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
        senses: [
          { translation: 'לראות', sense_code: 'perceive' },
          { translation: 'להבין', sense_code: 'understand' },
        ],
      },
      { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
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
        senses: [
          {
            translation: 'ספר',
            part_of_speech: 'noun',
            example: { source: 'I read a book.', target: 'קראתי ספר.' },
            sense_code: 'printed_book',
          },
          { translation: 'להזמין', sense_code: 'reserve' },
        ],
      },
    ]);

    expect(row.senses[0]).toEqual({
      rank: 0,
      senseCode: 'printed_book',
      partOfSpeech: 'noun',
      exampleSource: 'I read a book.',
      translation: 'ספר',
      exampleTarget: 'קראתי ספר.',
    });
    expect(row.senses[1]).toEqual({
      rank: 1,
      senseCode: 'reserve',
      partOfSpeech: null,
      exampleSource: null,
      translation: 'להזמין',
      exampleTarget: null,
    });
  });
});

describe('rowsToSenses', () => {
  const row = (over: Partial<SenseRow>): SenseRow => ({
    termId: 't-see',
    rank: 0,
    entryRank: 0,
    partOfSpeech: null,
    exampleSource: null,
    translation: 'לראות',
    exampleTarget: null,
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

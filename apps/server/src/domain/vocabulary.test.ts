import { describe, expect, it } from '@jest/globals';
import type { LlmEntry } from '@lang-tutor/core/api';

import { flattenEntries, mergeEntries } from './vocabulary';

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

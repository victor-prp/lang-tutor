import { describe, expect, it } from '@jest/globals';

import type { TypedTranslationQuestion } from '../api/types';
import { judgeTyped, normaliseTyped } from './typed';

const q = (answer: string, lemma = answer, alternatives: string[] = []): TypedTranslationQuestion => ({
  id: 'q1',
  type: 'typed_translation',
  vocab_term_id: 'l1',
  question: 'בית',
  part_of_speech: 'noun',
  answer,
  lemma,
  alternatives,
});

describe('normaliseTyped', () => {
  it('trims, collapses spaces, lowercases and drops trailing punctuation', () => {
    expect(normaliseTyped('  Thank   You! ')).toBe('thank you');
  });

  it('folds typographic apostrophes, as iOS smart punctuation types them', () => {
    expect(normaliseTyped('l’acqua')).toBe("l'acqua");
  });

  it('removes Cyrillic stress marks but keeps a Latin accent, decomposed or not', () => {
    expect(normaliseTyped('молоко́')).toBe('молоко');
    expect(normaliseTyped('perché')).toBe('perché');
  });
});

describe('judgeTyped', () => {
  it('is exact for the form, ignoring case and a trailing space', () => {
    expect(judgeTyped(q('casa'), 'Casa ')).toBe('exact');
  });

  it('is exact for the lemma of an inflected form', () => {
    expect(judgeTyped(q('parlo', 'parlare'), 'parlare')).toBe('exact');
  });

  it('is exact with a leading article or "to", added or dropped', () => {
    expect(judgeTyped(q('libro'), 'il libro')).toBe('exact');
    expect(judgeTyped(q('acqua'), "l'acqua")).toBe('exact');
    expect(judgeTyped(q('acqua'), 'l’acqua')).toBe('exact');
    expect(judgeTyped(q('remember'), 'to remember')).toBe('exact');
    expect(judgeTyped(q('to remember', 'remember'), 'remember')).toBe('exact');
  });

  it('is an alternative for another right word, before any near miss', () => {
    expect(judgeTyped(q('big', 'big', ['large']), 'large')).toBe('alternative');
    expect(judgeTyped(q('bello', 'bello', ['bella']), 'bella')).toBe('alternative');
  });

  it('is a near miss for a missing accent or ё, at any length', () => {
    expect(judgeTyped(q('perché'), 'perche')).toBe('near_miss');
    expect(judgeTyped(q('più'), 'piu')).toBe('near_miss');
    expect(judgeTyped(q('ёлка'), 'елка')).toBe('near_miss');
  });

  // Review: the ASCII way of writing an Italian accent is an apostrophe after
  // the vowel. It must never do worse than leaving the accent out.
  it('is a near miss for an accent written as an apostrophe after the vowel', () => {
    expect(judgeTyped(q('più'), "piu'")).toBe('near_miss');
    expect(judgeTyped(q('perché'), "perche'")).toBe('near_miss');
    expect(judgeTyped(q('città'), 'citta’')).toBe('near_miss');
    expect(judgeTyped(q('città'), 'citta`')).toBe('near_miss');
    expect(judgeTyped(q('città'), 'citta´')).toBe('near_miss');
  });

  it("keeps a real apostrophe exact: po' is spelt that way", () => {
    expect(judgeTyped(q("po'"), "po'")).toBe('exact');
    expect(judgeTyped(q("po'"), 'po’')).toBe('exact');
  });

  // Review: й is its own letter, not a dotted и, so мои is another word.
  it('does not read й as и with a mark', () => {
    expect(judgeTyped(q('мой'), 'мои')).toBe('wrong');
    expect(judgeTyped(q('чай'), 'чаи')).toBe('wrong');
  });

  it('is a near miss for one edit on a word of five letters or more', () => {
    expect(judgeTyped(q('finestra'), 'finestar')).toBe('near_miss');
    expect(judgeTyped(q('finestra'), 'fineestra')).toBe('near_miss');
    expect(judgeTyped(q('finestra'), 'finstra')).toBe('near_miss');
    expect(judgeTyped(q('finestra'), 'finestre')).toBe('near_miss');
  });

  it('is wrong for one edit on a short word, two edits, another word, or nothing', () => {
    expect(judgeTyped(q('casa'), 'cosa')).toBe('wrong');
    expect(judgeTyped(q('finestra'), 'finestro!x')).toBe('wrong');
    expect(judgeTyped(q('finestra'), 'porta')).toBe('wrong');
    expect(judgeTyped(q('finestra'), '')).toBe('wrong');
    expect(judgeTyped(q('finestra'), '   ')).toBe('wrong');
  });
});

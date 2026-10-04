import { describe, expect, it, jest } from '@jest/globals';
import type { TranslationSense, VocabularyWord } from '@lang-tutor/core/api';

import {
  appendPage,
  canSaveAll,
  savedStateOf,
  showsMark,
  toggleOptimistically,
  topSense,
  unsavedEntries,
  withSaved,
} from './vocabulary';

const SENSES: TranslationSense[] = [
  { translation: 'a', sense_id: 's1', variant_id: 'v1', saved: false },
  { translation: 'b', sense_id: 's2', variant_id: 'v1', saved: true },
  { translation: 'c', sense_id: 's3', variant_id: 'v1', saved: false },
  { translation: 'reverse', sense_id: 's4', variant_id: 'v2' },
  { translation: 'sentence' },
];

describe('savedStateOf', () => {
  it('maps only the senses the server said can be saved here', () => {
    expect(savedStateOf(SENSES)).toEqual({ s1: false, s2: true, s3: false });
  });
});

describe('unsavedEntries and canSaveAll', () => {
  it('lists the unsaved, saveable senses', () => {
    expect(unsavedEntries(SENSES, savedStateOf(SENSES))).toEqual([
      { sense_id: 's1', variant_id: 'v1' },
      { sense_id: 's3', variant_id: 'v1' },
    ]);
  });

  it('offers save-all from two unsaved senses, not one', () => {
    const saved = savedStateOf(SENSES);
    expect(canSaveAll(SENSES, saved)).toBe(true);
    expect(canSaveAll(SENSES, { ...saved, s1: true })).toBe(false);
  });
});

describe('topSense', () => {
  it('is the first sense, the card wearing the badge', () => {
    expect(topSense(SENSES)).toBe(SENSES[0]);
  });

  it('is undefined for an empty list', () => {
    expect(topSense([])).toBeUndefined();
  });
});

describe('withSaved', () => {
  it('sets every id to the value and leaves the rest, without mutating the input', () => {
    const before = { s1: false, s2: true, s3: false };
    expect(withSaved(before, ['s1', 's3'], true)).toEqual({ s1: true, s2: true, s3: true });
    expect(withSaved(before, ['s2'], false)).toEqual({ s1: false, s2: false, s3: false });
    expect(before).toEqual({ s1: false, s2: true, s3: false });
  });
});

describe('toggleOptimistically', () => {
  function fakes(request: () => Promise<unknown>) {
    const calls: string[] = [];
    const toggle = {
      next: true,
      apply: jest.fn((saved: boolean) => void calls.push(`apply(${saved})`)),
      inFlight: jest.fn((pending: boolean) => void calls.push(`inFlight(${pending})`)),
      request: jest.fn(() => {
        calls.push('request');
        return request();
      }),
    };
    return { calls, toggle };
  }

  it('flips first, marks the request in flight, then settles, resolving true', async () => {
    const { calls, toggle } = fakes(async () => undefined);
    await expect(toggleOptimistically(toggle)).resolves.toBe(true);
    expect(calls).toEqual(['apply(true)', 'inFlight(true)', 'request', 'inFlight(false)']);
  });

  it('reverts on failure, still settles, and resolves false rather than rejecting', async () => {
    const { calls, toggle } = fakes(async () => {
      throw new Error('boom');
    });
    await expect(toggleOptimistically(toggle)).resolves.toBe(false);
    expect(calls).toEqual(['apply(true)', 'inFlight(true)', 'request', 'apply(false)', 'inFlight(false)']);
  });

  it('reverts when request throws synchronously too', async () => {
    const { calls, toggle } = fakes(() => {
      throw new Error('sync');
    });
    await expect(toggleOptimistically(toggle)).resolves.toBe(false);
    expect(calls).toEqual(['apply(true)', 'inFlight(true)', 'request', 'apply(false)', 'inFlight(false)']);
  });
});

const word = (lexeme_id: string, over: Partial<VocabularyWord> = {}): VocabularyWord => ({
  lexeme_id,
  lemma: lexeme_id,
  part_of_speech: 'noun',
  headline: { sense_id: `s-${lexeme_id}`, translation: 't', form: lexeme_id },
  saved_count: 1,
  sense_count: 1,
  ...over,
});

describe('appendPage', () => {
  it('appends, dropping a word already loaded', () => {
    expect(appendPage([word('a'), word('b')], [word('b'), word('c')]).map((w) => w.lexeme_id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('showsMark', () => {
  it('marks a word with more than one sense', () => {
    expect(showsMark(word('a', { sense_count: 2 }))).toBe(true);
    expect(showsMark(word('a', { sense_count: 1 }))).toBe(false);
  });
});

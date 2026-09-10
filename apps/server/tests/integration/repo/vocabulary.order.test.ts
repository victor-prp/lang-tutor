import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createVocabRepo } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { insertTerm, type SeedSense } from '../../support/vocabRows';
import { withTx } from '../../support/withTx';

// The merge across headwords: this phase's most load-bearing rule, and the one
// a reader is most likely to mistake for a bug. Rows are inserted directly so
// nothing here depends on what a model happened to return.

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

const sense = (rank: number, translation: string): SeedSense => ({
  rank,
  senseCode: `s${rank}`,
  translation,
  partOfSpeech: null,
  exampleSource: null,
  exampleTarget: null,
});

const find = (form: string) =>
  withTx(t.db, (tx) =>
    createVocabRepo(tx).findSensesByForm({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
    }),
  );

/** `saw` is a variant of `see` (entry 0) and of `saw` (entry 1). */
async function seedSawAndSee(seeEntryRank: number, sawEntryRank: number): Promise<void> {
  await insertTerm(t.db, {
    lemma: 'see',
    languageCode: 'en',
    userLanguageCode: 'he',
    variants: [
      { form: 'see', kind: 'word', entryRank: 0 },
      { form: 'saw', kind: 'word', entryRank: seeEntryRank },
    ],
    senses: [sense(0, 'לראות'), sense(1, 'להבין'), sense(2, 'לפגוש')],
  });
  await insertTerm(t.db, {
    lemma: 'saw',
    languageCode: 'en',
    userLanguageCode: 'he',
    variants: [{ form: 'saw', kind: 'word', entryRank: sawEntryRank }],
    senses: [sense(0, 'מסור'), sense(1, 'לנסר')],
  });
}

describe('the by-form merge', () => {
  it('returns both headwords, interleaved by rank rather than blocked by entry', async () => {
    await seedSawAndSee(0, 1);

    expect((await find('saw')).map((row) => row.translation)).toEqual([
      'לראות', // see rank 0
      'מסור', // saw rank 0
      'להבין', // see rank 1
      'לנסר', // saw rank 1
      'לפגוש', // see rank 2
    ]);
  });

  it('lets entry_rank decide which headword leads inside one rank', async () => {
    await seedSawAndSee(1, 0);

    expect((await find('saw')).map((row) => row.translation).slice(0, 2)).toEqual([
      'מסור',
      'לראות',
    ]);
  });

  it('cannot let a five-sense headword push another headword\'s top sense off the cap', async () => {
    await insertTerm(t.db, {
      lemma: 'see',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'saw', kind: 'word', entryRank: 0 }],
      senses: [0, 1, 2, 3, 4].map((n) => sense(n, `see${n}`)),
    });
    await insertTerm(t.db, {
      lemma: 'saw',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'saw', kind: 'word', entryRank: 1 }],
      senses: [sense(0, 'מסור')],
    });

    const translations = (await find('saw')).map((row) => row.translation);
    expect(translations).toHaveLength(5);
    expect(translations).toContain('מסור');
    expect(translations[1]).toBe('מסור');
  });

  it('answers identical queries identically, because the sort is total', async () => {
    await seedSawAndSee(0, 1);

    const first = await find('saw');
    const second = await find('saw');
    const third = await find('SAW');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('refuses a second term claiming an occupied entry_rank for one form', async () => {
    await seedSawAndSee(0, 1);

    await expect(
      insertTerm(t.db, {
        lemma: 'sawn',
        languageCode: 'en',
        userLanguageCode: 'he',
        variants: [{ form: 'saw', kind: 'word', entryRank: 1 }],
        senses: [sense(0, 'x')],
      }),
    ).rejects.toThrow();
  });

  it('scopes that index by language, so a Hebrew form does not collide', async () => {
    await seedSawAndSee(0, 1);

    await expect(
      insertTerm(t.db, {
        lemma: 'saw',
        languageCode: 'he',
        userLanguageCode: 'en',
        variants: [{ form: 'saw', kind: 'word', entryRank: 0 }],
        senses: [sense(0, 'x')],
      }),
    ).resolves.toBeDefined();
  });
});

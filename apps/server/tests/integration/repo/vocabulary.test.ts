import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createVocabRepo } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { insertTerm, type SeedSense } from '../../support/vocabRows';
import { withTx } from '../../support/withTx';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(async () => {
  await t.close();
});

const sense = (rank: number, translation: string, over: Partial<SeedSense> = {}): SeedSense => ({
  rank,
  senseCode: `s${rank}`,
  translation,
  partOfSpeech: null,
  exampleSource: null,
  exampleTarget: null,
  ...over,
});

const find = (form: string, languageCode = 'en', userLanguageCode = 'he') =>
  withTx(t.db, (tx) =>
    createVocabRepo(tx).findSensesByForm({ form, languageCode, userLanguageCode }),
  );

describe('findSensesByForm', () => {
  it('matches case-insensitively, because the index is on lower(form)', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect((await find('Ladder')).map((row) => row.translation)).toEqual(['סולם']);
    expect((await find('LADDER')).map((row) => row.translation)).toEqual(['סולם']);
  });

  it('returns a term\'s senses in rank order', async () => {
    await insertTerm(t.db, {
      lemma: 'see',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'see', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'לראות'), sense(1, 'להבין'), sense(2, 'לפגוש')],
    });

    expect((await find('see')).map((row) => row.translation)).toEqual([
      'לראות',
      'להבין',
      'לפגוש',
    ]);
  });

  it('caps the read at five even though the database stores every sense', async () => {
    await insertTerm(t.db, {
      lemma: 'light',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'light', kind: 'word', entryRank: 0 }],
      senses: [0, 1, 2, 3, 4, 5, 6].map((n) => sense(n, `t${n}`)),
    });

    expect(await find('light')).toHaveLength(5);
  });

  it('carries the part of speech and both halves of the example', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [
        sense(0, 'סולם', {
          partOfSpeech: 'noun',
          exampleSource: 'She climbed the ladder.',
          exampleTarget: 'היא טיפסה על הסולם.',
        }),
      ],
    });

    expect(await find('ladder')).toEqual([
      {
        termId: expect.any(String),
        rank: 0,
        entryRank: 0,
        partOfSpeech: 'noun',
        exampleSource: 'She climbed the ladder.',
        translation: 'סולם',
        exampleTarget: 'היא טיפסה על הסולם.',
      },
    ]);
  });

  it('is a miss for a term with no translation in the language being asked for', async () => {
    // The inner join is the whole servability test: no column, no flag. An
    // earlier draft gated on the presence of an example, which would have made
    // an entry with a legally-absent example permanently unservable.
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect(await find('ladder', 'en', 'ru')).toEqual([]);
  });

  it('is a miss for a form nobody has queried, and for the wrong term language', async () => {
    await insertTerm(t.db, {
      lemma: 'ladder',
      languageCode: 'en',
      userLanguageCode: 'he',
      variants: [{ form: 'ladder', kind: 'word', entryRank: 0 }],
      senses: [sense(0, 'סולם')],
    });

    expect(await find('ladders')).toEqual([]);
    expect(await find('ladder', 'he', 'en')).toEqual([]);
  });
});

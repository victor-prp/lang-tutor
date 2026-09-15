import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { insertLexeme, type SeedVariant } from '../../support/dictRows';
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

/** One form's own renderings, ranked by their position in `translations`. Every
 *  variant of a lexeme carries its own, which is the phase 12 shape; here they
 *  happen to agree, because these cases are about the merge and not about
 *  rendering. */
const variant = (form: string, entryRank: number, translations: string[]): SeedVariant => ({
  form,
  kind: 'word',
  entryRank,
  translations: translations.map((translation, rank) => ({
    senseCode: `s${rank}`,
    rank,
    translation,
    exampleSource: null,
    exampleTarget: null,
  })),
});

const senses = (n: number) => Array.from({ length: n }, (_, i) => ({ senseCode: `s${i}` }));

const find = (form: string) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).findSensesByForm({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
    }),
  );

const SEE = ['לראות', 'להבין', 'לפגוש'];
const SAW = ['מסור', 'לנסר'];

/** `saw` is a variant of `see` (entry 0) and of `saw` (entry 1). */
async function seedSawAndSee(seeEntryRank: number, sawEntryRank: number): Promise<void> {
  await insertLexeme(t.db, {
    lemma: 'see',
    languageCode: 'en',
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: senses(3),
    variants: [variant('see', 0, SEE), variant('saw', seeEntryRank, SEE)],
  });
  await insertLexeme(t.db, {
    lemma: 'saw',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: senses(2),
    variants: [variant('saw', sawEntryRank, SAW)],
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

  // Phase 12: the two entries of `cook` are two LEXEMES of one lemma, not two
  // lemmas. The merge must interleave them exactly as it interleaves `see` and
  // `saw` — never both noun senses first.
  //
  // `cook` rather than the spec's `book` because `book` is one of the thirteen
  // seeded queries, so every cloned database already holds its two lexemes and
  // this insert would collide on dict_lexemes_language_lemma_pos_key.
  it('interleaves two lexemes of ONE lemma, exactly as it does two lemmas', async () => {
    await insertLexeme(t.db, {
      lemma: 'cook',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(2),
      variants: [variant('cook', 0, ['N1', 'N2'])],
    });
    await insertLexeme(t.db, {
      lemma: 'cook',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: senses(2),
      variants: [variant('cook', 1, ['V1', 'V2'])],
    });

    expect((await find('cook')).map((row) => row.translation)).toEqual(['N1', 'V1', 'N2', 'V2']);
  });

  it("cannot let a five-sense headword push another headword's top sense off the cap", async () => {
    await insertLexeme(t.db, {
      lemma: 'see',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: senses(5),
      variants: [variant('saw', 0, [0, 1, 2, 3, 4].map((n) => `see${n}`))],
    });
    await insertLexeme(t.db, {
      lemma: 'saw',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: senses(1),
      variants: [variant('saw', 1, ['מסור'])],
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

  it('refuses a second lexeme claiming an occupied entry_rank for one form', async () => {
    await seedSawAndSee(0, 1);

    await expect(
      insertLexeme(t.db, {
        lemma: 'sawn',
        languageCode: 'en',
        partOfSpeech: 'noun',
        userLanguageCode: 'he',
        senses: senses(1),
        variants: [variant('saw', 1, ['x'])],
      }),
    ).rejects.toThrow();
  });

  it('scopes that index by language, so a Hebrew form does not collide', async () => {
    await seedSawAndSee(0, 1);

    await expect(
      insertLexeme(t.db, {
        lemma: 'saw',
        languageCode: 'he',
        partOfSpeech: 'noun',
        userLanguageCode: 'en',
        senses: senses(1),
        variants: [variant('saw', 0, ['x'])],
      }),
    ).resolves.toBeDefined();
  });
});

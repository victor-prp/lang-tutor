import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { insertLexeme, type SeedVariant } from '../../support/dictRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/** Phase 39 (spec D1, D4). findLexemeForms: every spelling of a lexeme, lowercased. */

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const variant = (form: string, entryRank: number): SeedVariant => ({
  form,
  kind: 'word',
  entryRank,
  translations: [{ senseCode: 's0', rank: 0, translation: 'x', exampleSource: null, exampleTarget: null }],
});

// Sorted here: the database's collation orders 'pick up' and 'picked up' its own way.
const find = async (lexemeIds: string[]) =>
  [...(await withTx(t.db, (tx) => createDictRepo(tx).findLexemeForms({ lexemeIds })))].sort((a, b) => a.form.localeCompare(b.form));

describe('findLexemeForms', () => {
  it('returns each variant form and the lemma, lowercased and distinct, per lexeme', async () => {
    const pick = await insertLexeme(t.db, {
      lemma: 'Pick Up',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 's0' }],
      variants: [variant('Pick up', 0), variant('picked up', 1), variant('PICKS UP', 2)],
    });
    const other = await insertLexeme(t.db, {
      lemma: 'kite',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 's0' }],
      variants: [variant('kite', 0)],
    });
    expect(await find([pick.lexemeId])).toEqual(
      ['pick up', 'picked up', 'picks up'].map((form) => ({ lexemeId: pick.lexemeId, form })),
    );
    expect(await find([other.lexemeId, pick.lexemeId])).toHaveLength(4);
  });

  it('returns the lemma of a lexeme with no variants, and nothing for no ids', async () => {
    const bare = await insertLexeme(t.db, {
      lemma: 'Bare',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [],
      variants: [],
    });
    expect(await find([bare.lexemeId])).toEqual([{ lexemeId: bare.lexemeId, form: 'bare' }]);
    expect(await find([])).toEqual([]);
  });
});

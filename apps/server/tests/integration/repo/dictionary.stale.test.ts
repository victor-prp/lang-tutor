import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/**
 * Follows `dictionary.pos.test.ts`: `cook`, not `book`, because the seed holds
 * `book` and first-writer-wins would make every call below write nothing. The
 * `persist`/`find` helpers are copied verbatim rather than shared, so this
 * regression and that one can fail independently.
 */

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const persist = (form: string, entries: unknown) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
      entries: entries as never,
    }),
  );

const find = (form: string) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).findSensesByForm({
      form,
      languageCode: 'en',
      userLanguageCode: 'he',
    }),
  );

// `cook` is two lexemes. `cooks` realises both AND teaches the noun a second
// sense, which is the growth event the whole task is about.
const COOK = [
  { lemma: 'cook', part_of_speech: 'noun',
    senses: [{ sense_code: 'kitchen_worker', translation: 'N-COOK' }] },
  { lemma: 'cook', part_of_speech: 'verb',
    senses: [{ sense_code: 'prepare_food', translation: 'V-COOK' }] },
];

const COOKS_PLUS_ONE = [
  { lemma: 'cook', part_of_speech: 'noun',
    senses: [
      { sense_code: 'kitchen_worker',  translation: 'N-COOKS' },
      { sense_code: 'cookery_writer',  translation: 'N-COOKS-2' }, // learned here
    ] },
  { lemma: 'cook', part_of_speech: 'verb',
    senses: [{ sense_code: 'prepare_food', translation: 'V-COOKS' }] },
];

/** The variant id and its sense ids, as `persistEntries` reported them. */
const variantOf = async (form: string, partOfSpeech: string) => {
  const { written } = await persist(form, partOfSpeech === 'noun' ? [COOK[0]] : [COOK[1]]);
  return written[0];
};

describe('a form is re-rendered when its lexeme has learned more', () => {
  it('reports only the lexeme that is behind, across a form that spans two', async () => {
    await persist('cook', COOK);            // noun + verb, one sense each
    await persist('cooks', COOKS_PLUS_ONE); // teaches the NOUN a second sense

    const stale = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' }));

    expect(stale).toHaveLength(1);
    expect(stale[0].partOfSpeech).toBe('noun');
  });

  it('re-ranks rather than appends, and leaves ranks contiguous from zero', async () => {
    const noun = await variantOf('cook', 'noun');          // one sense, rank 0
    await persist('cooks', COOKS_PLUS_ONE);                // the lexeme gains a second
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' }));

    const stored = await withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByLexeme({
        lemma: 'cook', partOfSpeech: 'noun', languageCode: 'en', userLanguageCode: 'he',
      }));
    const idOf = (code: string) => stored.find((s) => s.senseCode === code)!.senseId;

    await withTx(t.db, (tx) =>
      createDictRepo(tx).repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senses: [
          // The NEWLY learned sense placed FIRST — which is the whole point.
          { senseId: idOf('cookery_writer'), rank: 0, translation: 'NEW-FIRST',  exampleSource: null, exampleTarget: null },
          { senseId: idOf('kitchen_worker'), rank: 1, translation: 'NEW-SECOND', exampleSource: null, exampleTarget: null },
        ],
      }));

    // Appending at max(rank)+1 would have put NEW-FIRST last, which is exactly
    // the failure the spec's "Sense order belongs to the form" describes.
    const rows = await find('cook');
    expect(rows.map((r) => r.translation)).toEqual(['NEW-FIRST', 'NEW-SECOND']);
    expect(rows.map((r) => r.rank)).toEqual([0, 1]);
    expect(noun.variantId).toBe(stale.variantId);
  });

  it('marks the variant level again, so a second lookup is not a second repair', async () => {
    await variantOf('cook', 'noun');
    await persist('cooks', COOKS_PLUS_ONE);
    const [stale] = await withTx(t.db, (tx) =>
      createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' }));

    const stored = await withTx(t.db, (tx) =>
      createDictRepo(tx).findSensesByLexeme({
        lemma: 'cook', partOfSpeech: 'noun', languageCode: 'en', userLanguageCode: 'he',
      }));

    await withTx(t.db, (tx) =>
      createDictRepo(tx).repairVariantRenderings({
        variantId: stale.variantId, lexemeId: stale.lexemeId, userLanguageCode: 'he',
        senses: stored.map((sense, rank) => ({
          senseId: sense.senseId, rank, translation: `R-${rank}`,
          exampleSource: null, exampleTarget: null,
        })),
      }));

    expect(
      await withTx(t.db, (tx) =>
        createDictRepo(tx).findStaleLexemesByForm({ form: 'cook', languageCode: 'en' })),
    ).toEqual([]);
  });
});

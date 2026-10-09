import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { createDictRepo } from '../../../src/repo/dictionary';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

/**
 * The defect spec §1 names: one counter per variant, while a rendering is per
 * (variant, user_language_code). A Hebrew variant rendered into both English
 * and Russian learns a sense; a repair in English must NOT mark the Russian
 * rendering current.
 *
 * `גזר` (carrot / he cut), not a seeded word, so first-writer-wins writes it.
 */

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

const persist = (form: string, userLanguageCode: string, entries: unknown) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).persistEntries({
      form,
      languageCode: 'he',
      userLanguageCode,
      kind: 'word',
      entries: entries as never,
    }),
  );

const stale = (form: string, userLanguageCode: string) =>
  withTx(t.db, (tx) =>
    createDictRepo(tx).findStaleLexemesByForm({ form, languageCode: 'he', userLanguageCode }),
  );

const ONE_SENSE = (translation: string) => [
  { lemma: 'גזר', part_of_speech: 'noun', senses: [{ sense_code: 'root_vegetable', translation }] },
];

// A second form of the same lexeme that teaches it a second sense.
const PLURAL_TEACHES_A_SENSE = [
  {
    lemma: 'גזר',
    part_of_speech: 'noun',
    senses: [
      { sense_code: 'root_vegetable', translation: 'carrots' },
      { sense_code: 'reward_incentive', translation: 'incentives' },
    ],
  },
];

describe('per-language rendering freshness', () => {
  it('is level in every language a form was written in', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזר', 'ru', ONE_SENSE('морковь'));
    expect(await stale('גזר', 'en')).toEqual([]);
    expect(await stale('גזר', 'ru')).toEqual([]);
  });

  it('goes stale in every language when the lexeme learns a sense', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזר', 'ru', ONE_SENSE('морковь'));
    await persist('גזרים', 'en', PLURAL_TEACHES_A_SENSE);

    expect(await stale('גזר', 'en')).toHaveLength(1);
    expect(await stale('גזר', 'ru')).toHaveLength(1);
  });

  it('a repair in one language leaves the other language stale', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזר', 'ru', ONE_SENSE('морковь'));
    await persist('גזרים', 'en', PLURAL_TEACHES_A_SENSE);

    const [lexeme] = await stale('גזר', 'en');
    await withTx(t.db, async (tx) => {
      const repo = createDictRepo(tx);
      const senseVersion = await repo.findSenseVersion({ lexemeId: lexeme.lexemeId });
      const stored = await repo.findSensesByLexeme({
        lemma: 'גזר',
        partOfSpeech: 'noun',
        languageCode: 'he',
        userLanguageCode: 'en',
      });
      await repo.lockLexemes([lexeme.lexemeId]);
      await repo.repairVariantRenderings({
        variantId: lexeme.variantId,
        lexemeId: lexeme.lexemeId,
        userLanguageCode: 'en',
        senseVersion,
        lemmaForm: true,
        senses: stored.map((sense, rank) => ({
          senseId: sense.senseId,
          rank,
          translation: sense.translation,
          alternatives: [],
          gloss: sense.translation,
          glossAlternatives: [],
          definition: null,
          exampleSource: null,
          exampleTarget: null,
        })),
      });
    });

    expect(await stale('גזר', 'en')).toEqual([]);
    // The bug this table exists to fix: under one counter per variant, this was [].
    expect(await stale('גזר', 'ru')).toHaveLength(1);
  });

  it('never calls a variant stale in a language it has no rendering in', async () => {
    await persist('גזר', 'en', ONE_SENSE('carrot'));
    await persist('גזרים', 'en', PLURAL_TEACHES_A_SENSE);
    // No Russian rendering exists, so nothing is served in Russian and there is
    // nothing to repair from: a repair call here could only come back empty.
    expect(await stale('גזר', 'ru')).toEqual([]);
  });
});
